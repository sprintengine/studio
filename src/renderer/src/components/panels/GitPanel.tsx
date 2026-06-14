import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStatus } from '../../hooks/useGitStatus'
import { getGitScopeStatusAppearance, getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { focusOrAddFileTab, focusOrAddGitConflictTab, focusOrAddTerminalTab } from '../../utils/modelRegistry'
import { isImageFile } from '../../utils/files'
import { basename, samePath, trimPath } from '../../utils/paths'
import WorktreeManager from '../worktree/WorktreeManager'
import PlainTerminalPanel from './PlainTerminalPanel'
import { IconButton, InboxRow, Select, Skeleton, StatusDot, Tooltip, type Tone } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { GitGraphView, type GitCommitActions, type GitGraphState } from './GitGraphView'

// Status is conveyed by colour-coded filename text (see getGitStatusAppearance);
// this supplies the non-visual equivalent for the row's accessible name, since
// colour alone is not an accessible signal.
function gitStatusWord(status: GitFileStatus | null): string | null {
  switch (status) {
    case 'new':
      return 'added'
    case 'modified':
      return 'modified'
    case 'renamed':
      return 'renamed'
    case 'deleted':
      return 'deleted'
    case 'conflicted':
      return 'conflicted'
    default:
      return null
  }
}

type GitPanelMessage = {
  tone: 'neutral' | 'error' | 'success'
  text: string
}

type GitChangeGroup = {
  title: string
  empty: string
  actionTitle: string
  actionIcon: GitActionIconKind
  action: (path: string) => Promise<unknown>
  secondaryAction?: {
    title: string
    icon: GitActionIconKind
    action: (entry: GitStatusEntry) => Promise<unknown>
  }
  bulkActions?: GitBulkAction[]
  entries: GitStatusEntry[]
  omittedCount: number
}

type GitActionIconKind = 'stage' | 'unstage' | 'revert'

type GitBulkAction = {
  label: string
  title: string
  danger?: boolean
  action: () => Promise<unknown>
}

type GitScopeKind = 'main' | 'worktree'

type GitPanelView = 'changes' | 'worktrees' | 'log' | 'terminal'

type GitScopeOption = {
  id: string
  kind: GitScopeKind
  label: string
  path: string
  branch: string | null
  head: string | null
  missing: boolean
  locked: boolean
  prunable: boolean
}

type ReviewDiffTarget = {
  baseRef: string
  reason: string
}

const MAX_RENDERED_GIT_CHANGES_PER_GROUP = 500
const GIT_PANEL_AUTO_REFRESH_MS = 10_000
const GIT_GRAPH_PAGE_SIZE = 200
const STANDARD_BASE_BRANCHES = ['main', 'master', 'develop', 'trunk']

function RefreshGitIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M13.25 7.25A5.25 5.25 0 0 0 4.05 4.1L2.75 5.5m0 0H6m-3.25 0V2.25M2.75 8.75a5.25 5.25 0 0 0 9.2 3.15l1.3-1.4m0 0H10m3.25 0v3.25"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GitActionIcon({ kind }: { kind: GitActionIconKind }) {
  if (kind === 'stage') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
        <path d="M8 3.25V12.75M4.25 8H11.75" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'unstage') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
        <path d="M4.25 8H11.75" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M5.2 4.5H2.85V2.15M3.1 7.8A4.95 4.95 0 1 0 4.45 4.4L2.85 6"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function sortedEntries(entries: GitStatusEntry[]): GitStatusEntry[] {
  return [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function branchOrHeadLabel(branch: string | null, head: string | null): string {
  if (branch) return branch
  if (head) return head.slice(0, 8)
  return 'detached'
}

function scopeId(kind: GitScopeKind, pathValue: string): string {
  return `${kind}:${trimPath(pathValue).toLowerCase()}`
}

function terminalIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'repo'
}

function formatScopeOptionLabel(scope: GitScopeOption): string {
  const suffix = scope.missing ? ' missing' : scope.prunable ? ' prunable' : scope.locked ? ' locked' : ''
  return scope.kind === 'main'
    ? `Main checkout - ${basename(scope.path)}${suffix}`
    : `${branchOrHeadLabel(scope.branch, scope.head)} - ${basename(scope.path)}${suffix}`
}

function isSafeGitRefForShell(ref: string): boolean {
  return /^[A-Za-z0-9._/@{}~^:-]+$/.test(ref)
}

function resolveReviewDiffTarget(branches: GitBranchSnapshot | null, activeScope: GitScopeOption | null): ReviewDiffTarget {
  const currentBranch = branches?.branches.find((branch) => branch.current) ?? null
  if (currentBranch?.upstream) {
    return { baseRef: currentBranch.upstream, reason: 'using the current branch upstream' }
  }

  const fallbackBranches = ['main', 'master', 'develop', 'trunk']
  const fallback = branches?.branches.find((branch) =>
    fallbackBranches.includes(branch.name) && branch.name !== branches.current
  )
  if (fallback) {
    return { baseRef: fallback.name, reason: 'using the nearest standard local base branch' }
  }

  if (activeScope?.kind === 'worktree') {
    return { baseRef: 'HEAD~1', reason: 'using HEAD~1 because no upstream or standard base branch is available' }
  }

  return { baseRef: 'HEAD~1', reason: 'using HEAD~1' }
}

function scopeAppearanceTone(label: string): Tone {
  if (label === 'Missing' || label === 'Prunable') return 'error'
  if (label === 'Locked') return 'warn'
  if (label === 'Ready') return 'good'
  return 'neutral'
}

function splitGitPath(relativePath: string): { directory: string; filename: string } {
  const lastSlashIndex = relativePath.lastIndexOf('/')
  if (lastSlashIndex === -1) {
    return { directory: '', filename: relativePath }
  }

  return {
    directory: relativePath.slice(0, lastSlashIndex),
    filename: relativePath.slice(lastSlashIndex + 1),
  }
}

function resultMessage(result: GitCommandResult, fallback: string): GitPanelMessage {
  if (result.ok) {
    return { tone: 'success', text: fallback }
  }

  return { tone: 'error', text: result.message || result.stderr.trim() || 'Git command failed.' }
}

function pushedCommitMessage(result: GitCommandResult): string {
  if (typeof result.pushedCommitCount !== 'number') return 'Pushed branch.'
  if (result.pushedCommitCount === 0) return 'Pushed 0 commits.'
  if (result.pushedCommitCount === 1) return 'Pushed 1 commit.'
  return `Pushed ${result.pushedCommitCount} commits.`
}

function syncStatusLabel(branches: GitBranchSnapshot | null): string {
  if (!branches) return 'Checking branch'
  if (branches.ahead && branches.behind) return `Ahead ${branches.ahead}, behind ${branches.behind}`
  if (branches.ahead) return `Ahead ${branches.ahead}`
  if (branches.behind) return `Behind ${branches.behind}`
  return 'Up to date'
}

export default function GitPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const folderPath = workspace?.folderPath ?? null
  const openFile = useWorkspaceStore((s) => s.openFile)
  const mainGit = useGitStatus(folderPath)
  const mainRepoRoot = mainGit.repoRoot
  const [scopeOptions, setScopeOptions] = useState<GitScopeOption[]>([])
  const [activeScopeId, setActiveScopeId] = useState('main')
  const activeScope = useMemo(
    () => scopeOptions.find((scope) => scope.id === activeScopeId) ?? scopeOptions[0] ?? null,
    [activeScopeId, scopeOptions]
  )
  const activeRootPath = activeScope?.path ?? folderPath
  const { repoRoot, status, repoState, refresh } = useGitStatus(activeRootPath)
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [graph, setGraph] = useState<GitGraphState>({ status: 'loading' })
  const [loadingMoreGraph, setLoadingMoreGraph] = useState(false)
  const [message, setMessage] = useState<GitPanelMessage | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<GitPanelView>('changes')
  const dialog = useConfirmDialog()
  const refreshAllInFlightRef = useRef(false)
  const refreshAllQueuedHistoryLoadingRef = useRef<boolean | null>(null)
  const graphLimitRef = useRef(GIT_GRAPH_PAGE_SIZE)

  const refreshWorktreeScopes = useCallback(async () => {
    if (!mainRepoRoot || typeof window.api.listGitWorktrees !== 'function') {
      setScopeOptions([])
      return
    }

    const fallbackMainScope: GitScopeOption = {
      id: 'main',
      kind: 'main',
      label: `Main checkout - ${basename(mainRepoRoot)}`,
      path: mainRepoRoot,
      branch: null,
      head: null,
      missing: false,
      locked: false,
      prunable: false,
    }

    try {
      const result = await window.api.listGitWorktrees(mainRepoRoot)
      if (!result.ok) {
        setScopeOptions([fallbackMainScope])
        return
      }

      const listedMain = result.data.worktrees.find((worktree) => samePath(worktree.path, mainRepoRoot)) ?? null
      const mainScope: GitScopeOption = {
        ...fallbackMainScope,
        branch: listedMain?.branch ?? null,
        head: listedMain?.head ?? null,
        locked: listedMain?.locked ?? false,
        prunable: listedMain?.prunable ?? false,
      }

      const worktreeScopes = await Promise.all(
        result.data.worktrees
          .filter((worktree) => !samePath(worktree.path, mainRepoRoot))
          .map(async (worktree): Promise<GitScopeOption> => {
            const missing = !(await window.api.pathExists(worktree.path).catch(() => false))
            const scope: GitScopeOption = {
              id: scopeId('worktree', worktree.path),
              kind: 'worktree',
              label: '',
              path: worktree.path,
              branch: worktree.branch,
              head: worktree.head,
              missing,
              locked: worktree.locked,
              prunable: worktree.prunable,
            }
            return { ...scope, label: formatScopeOptionLabel(scope) }
          })
      )

      setScopeOptions([mainScope, ...worktreeScopes])
    } catch {
      setScopeOptions([fallbackMainScope])
    }
  }, [mainRepoRoot])

  useEffect(() => {
    void refreshWorktreeScopes()
  }, [refreshWorktreeScopes])

  useEffect(() => {
    if (scopeOptions.length === 0) return
    if (scopeOptions.some((scope) => scope.id === activeScopeId)) return
    setActiveScopeId('main')
  }, [activeScopeId, scopeOptions])

  useEffect(() => {
    if (!activeScope || activeScope.kind === 'main') return
    if (!activeScope.missing && !activeScope.locked && !activeScope.prunable) return
    setActiveScopeId('main')
  }, [activeScope])

  const refreshBranches = useCallback(async () => {
    if (!repoRoot || typeof window.api.getGitBranches !== 'function') {
      setBranches(null)
      return
    }

    try {
      setBranches(await window.api.getGitBranches(repoRoot))
    } catch {
      setBranches(null)
    }
  }, [repoRoot])

  const refreshGraph = useCallback(async (showLoading = true) => {
    if (!repoRoot || typeof window.api.getGitCommitGraph !== 'function') {
      setGraph({
        status: 'error',
        message: 'Restart the app to enable the commit graph.',
      })
      return
    }

    if (showLoading) setGraph({ status: 'loading' })
    try {
      const snapshot = await window.api.getGitCommitGraph(repoRoot, { limit: graphLimitRef.current })
      setGraph({ status: 'ready', snapshot })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setGraph({
        status: 'error',
        message: message.includes("No handler registered for 'git:get-commit-graph'")
          ? 'Restart the app to enable the commit graph.'
          : 'Unable to load the commit graph.',
      })
    }
  }, [repoRoot])

  const handleLoadMoreGraph = useCallback(async () => {
    graphLimitRef.current += GIT_GRAPH_PAGE_SIZE
    setLoadingMoreGraph(true)
    try {
      await refreshGraph(false)
    } finally {
      setLoadingMoreGraph(false)
    }
  }, [refreshGraph])

  const refreshAll = useCallback(async (showHistoryLoading = true) => {
    if (refreshAllInFlightRef.current) {
      refreshAllQueuedHistoryLoadingRef.current = Boolean(refreshAllQueuedHistoryLoadingRef.current) || showHistoryLoading
      return
    }

    refreshAllInFlightRef.current = true
    try {
      let shouldShowHistoryLoading = showHistoryLoading
      while (true) {
        refreshAllQueuedHistoryLoadingRef.current = null
        await Promise.all([refresh(), refreshBranches(), refreshGraph(shouldShowHistoryLoading), refreshWorktreeScopes()])

        const queuedShowHistoryLoading = refreshAllQueuedHistoryLoadingRef.current
        if (queuedShowHistoryLoading === null) break
        shouldShowHistoryLoading = queuedShowHistoryLoading
      }
    } finally {
      refreshAllInFlightRef.current = false
    }
  }, [refresh, refreshBranches, refreshGraph, refreshWorktreeScopes])

  useEffect(() => {
    // Reset graph pagination whenever the scope/repo changes.
    graphLimitRef.current = GIT_GRAPH_PAGE_SIZE
    void refreshBranches()
    void refreshGraph()
  }, [refreshBranches, refreshGraph])

  useEffect(() => {
    if (!repoRoot) return

    const interval = window.setInterval(() => {
      if (document.hidden) return
      void refreshAll(false)
    }, GIT_PANEL_AUTO_REFRESH_MS)

    return () => window.clearInterval(interval)
  }, [refreshAll, repoRoot])

  const statusEntries = useMemo(() => Object.values(status?.files ?? {}), [status])
  const conflictEntries = useMemo(
    () => sortedEntries(statusEntries.filter((entry) => entry.status === 'conflicted')),
    [statusEntries]
  )
  const nonConflictEntries = useMemo(
    () => statusEntries.filter((entry) => entry.status !== 'conflicted'),
    [statusEntries]
  )
  const stagedEntries = useMemo(
    () => sortedEntries(nonConflictEntries.filter((entry) => entry.staged)),
    [nonConflictEntries]
  )
  const unstagedEntries = useMemo(
    () => sortedEntries(nonConflictEntries.filter((entry) => entry.unstaged)),
    [nonConflictEntries]
  )
  const allEntries = useMemo(() => sortedEntries(statusEntries), [statusEntries])
  const branchOptions = branches?.branches ?? []
  const worktreeCount = scopeOptions.filter((scope) => scope.kind === 'worktree').length
  const totalCommitCount = graph.status === 'ready' ? graph.snapshot.totalCount : 0
  const detachedReturnBranch = useMemo(() => {
    // In detached HEAD, `git branch` yields an empty-named pseudo-entry; ignore it.
    const named = branchOptions.filter((branch) => branch.name.trim().length > 0)
    const standard = named.find((branch) => STANDARD_BASE_BRANCHES.includes(branch.name))
    return standard?.name ?? named[0]?.name ?? null
  }, [branchOptions])
  const readyToCommit = stagedEntries.length > 0 && Boolean(commitMessage.trim())
  const activeScopeLabel = activeScope?.label ?? 'Current checkout'
  const activeScopePath = repoRoot ?? activeRootPath ?? ''
  const activeScopeAppearance = getGitScopeStatusAppearance(activeScope)
  const reviewDiffTarget = useMemo(
    () => resolveReviewDiffTarget(branches, activeScope),
    [activeScope, branches]
  )

  const runAction = async (
    label: string,
    action: () => Promise<GitCommandResult>,
    success: string
  ): Promise<GitCommandResult | null> => {
    if (busy) return null
    setBusy(label)
    setMessage({ tone: 'neutral', text: `${label}...` })
    try {
      const result = await action()
      setMessage(resultMessage(result, success))
      if (result.ok) {
        await refreshAll()
      }
      return result
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
      return null
    } finally {
      setBusy(null)
    }
  }

  const stagePath = (path: string) =>
    runAction('Staging file', () => window.api.stageGitPaths(repoRoot!, [path]), 'Staged file.')
  const unstagePath = (path: string) =>
    runAction('Unstaging file', () => window.api.unstageGitPaths(repoRoot!, [path]), 'Unstaged file.')
  const revertPath = async (entry: GitStatusEntry) => {
    const confirmed = await dialog.confirm({
      title: `Revert ${entry.relativePath}?`,
      body: (
        <>
          This reverts every change to {entry.relativePath} in {activeScopeLabel}. The action cannot be undone from Multicode.
          <div className="mt-2 font-mono text-[12px] text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
        </>
      ),
      confirmLabel: 'Revert file',
      tone: 'danger',
    })
    if (!confirmed) return null

    return runAction('Reverting file', () => window.api.revertGitPaths(repoRoot!, [entry.path]), 'Reverted file.')
  }
  const discardUnstagedChanges = async () => {
    const confirmed = await dialog.confirm({
      title: 'Discard unstaged changes?',
      body: (
        <>
          This rolls back every unstaged edit in {activeScopeLabel} and removes untracked files. The action cannot be undone from Multicode.
          <div className="mt-2 font-mono text-[12px] text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
        </>
      ),
      confirmLabel: 'Discard changes',
      tone: 'danger',
    })
    if (!confirmed) return null

    return runAction(
      'Rolling back unstaged changes',
      () => window.api.discardUnstagedGitChanges(repoRoot!, []),
      'Rolled back unstaged changes.'
    )
  }

  const groups: GitChangeGroup[] = [
    {
      title: `Staged (${stagedEntries.length})`,
      empty: 'No staged changes',
      actionTitle: 'Unstage this file',
      actionIcon: 'unstage',
      action: unstagePath,
      secondaryAction: {
        title: 'Revert this file',
        icon: 'revert',
        action: revertPath,
      },
      bulkActions: [
        {
          label: 'Unstage All',
          title: 'Unstage all staged changes',
          action: () => runAction('Unstaging all', () => window.api.unstageGitPaths(repoRoot!, []), 'Unstaged all files.'),
        },
      ],
      entries: stagedEntries.slice(0, MAX_RENDERED_GIT_CHANGES_PER_GROUP),
      omittedCount: Math.max(0, stagedEntries.length - MAX_RENDERED_GIT_CHANGES_PER_GROUP),
    },
    {
      title: `Unstaged (${unstagedEntries.length})`,
      empty: 'No unstaged changes',
      actionTitle: 'Stage this file',
      actionIcon: 'stage',
      action: stagePath,
      secondaryAction: {
        title: 'Revert this file',
        icon: 'revert',
        action: revertPath,
      },
      bulkActions: [
        {
          label: 'Stage All',
          title: 'Stage all changes',
          action: () => runAction('Staging all', () => window.api.stageGitPaths(repoRoot!, []), 'Staged all changes.'),
        },
        {
          label: 'Discard',
          title: 'Roll back all unstaged changes',
          danger: true,
          action: discardUnstagedChanges,
        },
      ],
      entries: unstagedEntries.slice(0, MAX_RENDERED_GIT_CHANGES_PER_GROUP),
      omittedCount: Math.max(0, unstagedEntries.length - MAX_RENDERED_GIT_CHANGES_PER_GROUP),
    },
  ]

  const handleCommit = async () => {
    if (!repoRoot) return
    const result = await runAction(
      'Committing',
      () => window.api.commitGitChanges(repoRoot, commitMessage),
      'Committed changes.'
    )
    if (result?.ok) setCommitMessage('')
  }

  const handlePush = async () => {
    if (!repoRoot) return
    const result = await runAction('Pushing', () => window.api.pushGitBranch(repoRoot), 'Pushing branch...')
    if (result?.ok) setMessage({ tone: 'success', text: pushedCommitMessage(result) })
  }

  const handleFetch = async () => {
    if (!repoRoot) return
    if (typeof window.api.fetchGitRemotes !== 'function') {
      setMessage({ tone: 'error', text: 'Restart the app to enable Git fetch.' })
      return
    }
    await runAction('Fetching', () => window.api.fetchGitRemotes(repoRoot), 'Fetched remotes.')
  }

  const handlePull = async () => {
    if (!repoRoot) return
    if (typeof window.api.pullGitBranchWithStash !== 'function') {
      setMessage({ tone: 'error', text: 'Restart the app to enable Git pull.' })
      return
    }
    const result = await runAction(
      'Pulling',
      () => window.api.pullGitBranchWithStash(repoRoot),
      'Pulled branch and reapplied local changes.'
    )
    if (result && !result.ok) {
      await refreshAll()
    }
  }

  // CommandPalette / keyboard dispatcher → panel-command bridge. The command
  // registry only exposes these ids while this panel is mounted (gitPanelActive
  // availability), so a dispatch always lands on the real handlers below. A
  // latest-handler ref keeps the window listener stable across re-renders while
  // capturing the live commit message / repo closures.
  const gitCommandHandlerRef = useRef<(detail: { id: unknown; workspaceId?: unknown }) => void>(() => {})
  gitCommandHandlerRef.current = (detail) => {
    if (!detail || typeof detail.id !== 'string') return
    // Targeted dispatch: ignore commands meant for another workspace's Git panel
    // so a commit/fetch only runs in the workspace the user acted from.
    if (typeof detail.workspaceId === 'string' && detail.workspaceId !== workspaceId) return
    switch (detail.id) {
      case 'git.refresh':
        void refreshAll()
        break
      case 'git.fetch':
        void handleFetch()
        break
      case 'git.commit':
        void handleCommit()
        break
    }
  }
  useEffect(() => {
    const onCommand = (event: Event) => {
      gitCommandHandlerRef.current((event as CustomEvent).detail)
    }
    window.addEventListener('multicode:panel-command', onCommand)
    return () => window.removeEventListener('multicode:panel-command', onCommand)
  }, [])

  const handleSwitchBranch = async (branchName: string) => {
    if (!repoRoot || !branchName || branchName === branches?.current) return
    const checkedOutElsewhere = scopeOptions.find((scope) =>
      scope.branch === branchName && !samePath(scope.path, repoRoot)
    )
    if (checkedOutElsewhere) {
      const confirmed = await dialog.confirm({
        title: `Branch already checked out`,
        body: (
          <>
            Branch <span className="font-mono">{branchName}</span> is already checked out at:
            <div className="mt-2 font-mono text-[12px] text-[color:var(--text-muted)]">{checkedOutElsewhere.path}</div>
            <div className="mt-2">Git may refuse to switch to it here.</div>
          </>
        ),
        confirmLabel: 'Switch anyway',
        tone: 'danger',
      })
      if (!confirmed) {
        setMessage({ tone: 'neutral', text: `Branch switch cancelled. ${branchName} is checked out at ${checkedOutElsewhere.path}.` })
        return
      }
    }
    await runAction(
      'Switching branch',
      () => window.api.switchGitBranch(repoRoot, branchName),
      `Switched to ${branchName}.`
    )
  }

  const handleCheckoutCommit = async (commit: GitGraphCommit) => {
    if (!repoRoot) return
    const confirmed = await dialog.confirm({
      title: `Checkout ${commit.shortHash}?`,
      body: (
        <>
          This detaches HEAD onto <span className="font-mono">{commit.shortHash}</span> — “{commit.subject}”. Your
          branch pointer stays put; commits made here are easy to lose until you create a branch from them.
        </>
      ),
      confirmLabel: 'Checkout commit',
    })
    if (!confirmed) return
    await runAction(
      'Checking out commit',
      () => window.api.checkoutGitCommit(repoRoot, commit.hash),
      `Checked out ${commit.shortHash} (detached HEAD).`
    )
  }

  const handleCreateBranchFromCommit = async (commit: GitGraphCommit) => {
    if (!repoRoot) return
    const name = await dialog.prompt({
      title: `New branch from ${commit.shortHash}`,
      body: <>Creates a branch at “{commit.subject}” and switches to it.</>,
      inputLabel: 'Branch name',
      placeholder: 'feature/my-branch',
      required: true,
      confirmLabel: 'Create & switch',
    })
    if (!name) return
    await runAction(
      'Creating branch',
      () => window.api.checkoutGitCommitAsBranch(repoRoot, name, commit.hash),
      `Created and switched to ${name.trim()}.`
    )
  }

  const handleCreateTagFromCommit = async (commit: GitGraphCommit) => {
    if (!repoRoot) return
    const name = await dialog.prompt({
      title: `New tag at ${commit.shortHash}`,
      body: <>Tags “{commit.subject}”.</>,
      inputLabel: 'Tag name',
      placeholder: 'v1.0.0',
      required: true,
      confirmLabel: 'Create tag',
    })
    if (!name) return
    await runAction(
      'Creating tag',
      () => window.api.createGitTagFromCommit(repoRoot, name, commit.hash),
      `Tagged ${commit.shortHash} as ${name.trim()}.`
    )
  }

  const copyToClipboard = async (value: string, success: string) => {
    try {
      await window.api.clipboardWriteText(value)
      setMessage({ tone: 'success', text: success })
    } catch {
      setMessage({ tone: 'error', text: 'Could not copy to the clipboard.' })
    }
  }

  const commitActions: GitCommitActions = {
    checkout: (commit) => void handleCheckoutCommit(commit),
    createBranch: (commit) => void handleCreateBranchFromCommit(commit),
    createTag: (commit) => void handleCreateTagFromCommit(commit),
    copyHash: (commit) => void copyToClipboard(commit.hash, `Copied ${commit.shortHash}.`),
    copySubject: (commit) => void copyToClipboard(commit.subject, 'Copied commit subject.'),
    openOnGitHub: (commit) => {
      if (commit.commitWebUrl) window.open(commit.commitWebUrl, '_blank', 'noopener,noreferrer')
    },
  }

  const handleReviewDiff = async () => {
    if (!repoRoot || !activeScope || activeScope.kind !== 'worktree') return
    if (!isSafeGitRefForShell(reviewDiffTarget.baseRef)) {
      setMessage({
        tone: 'error',
        text: `Cannot open review diff because the base ref needs manual shell escaping: ${reviewDiffTarget.baseRef}`,
      })
      return
    }

    const terminalId = `git-review-${Date.now()}`
    const range = `${reviewDiffTarget.baseRef}...HEAD`
    const command = [
      'git status --short --branch',
      `git diff --stat --find-renames ${range} -- .`,
      `git diff --find-renames ${range} -- .`,
      '',
    ].join('\n')

    const result = await window.api.terminalSpawn(
      `terminal-${terminalId}`,
      100,
      30,
      repoRoot,
      false,
      workspace?.sprintEngineContext?.statePath,
      undefined,
      undefined,
      undefined,
      true,
      {
        kind: 'terminal',
        workspaceId,
        terminalId,
      }
    )

    if (!result.ok) {
      setMessage({ tone: 'error', text: result.message })
      return
    }

    await window.api.terminalWrite(`terminal-${terminalId}`, command)
    focusOrAddTerminalTab(workspaceId, terminalId, `Diff ${branchOrHeadLabel(activeScope.branch, activeScope.head)}`)
    setMessage({ tone: 'neutral', text: `Opened review diff: ${range} (${reviewDiffTarget.reason}).` })
  }

  const handleResolveConflict = (entry: GitStatusEntry) => {
    if (!repoRoot) return
    const label = `Resolve ${entry.relativePath.split('/').filter(Boolean).pop() ?? entry.relativePath}`
    const opened = focusOrAddGitConflictTab(workspaceId, repoRoot, entry.path, label)
    if (!opened) {
      setMessage({ tone: 'error', text: 'Unable to open conflict resolver tab.' })
    }
  }

  const handleOpenFile = async (entry: GitStatusEntry) => {
    const name = entry.relativePath.split('/').filter(Boolean).pop() ?? entry.relativePath
    let content = ''

    if (!isImageFile(entry.path || name)) {
      try {
        content = await window.api.readfile(entry.path)
      } catch {
        if (repoRoot && typeof window.api.getGitFileBase === 'function') {
          const result = await window.api.getGitFileBase(repoRoot, entry.path)
          content = result.ok ? result.content : ''
        }
      }
    }

    openFile(workspaceId, entry.path, name, content)
    focusOrAddFileTab(workspaceId, entry.path, name)
  }

  if (!folderPath) {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--bg-surface)] px-6 text-center text-[12px] text-[color:var(--text-disabled)]">
        Open a folder to use Git controls.
      </div>
    )
  }

  // `repoRoot` is null both while we are still resolving the repository and when
  // the folder genuinely is not a repo. Only the resolved `not-git` state should
  // show the "not a Git repository" copy — during resolution we show the
  // skeleton so the panel never flashes a misleading verdict on refresh.
  if (repoState === 'idle' || repoState === 'loading') {
    return <GitPanelSkeleton />
  }

  if (!repoRoot) {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--bg-surface)] px-6 text-center text-[12px] text-[color:var(--text-disabled)]">
        This folder is not a Git repository.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[color:var(--bg-surface)] text-[color:var(--text-default)]">
      {/*
       * Contextual header, aligned with FileExplorer / Knowledge Graph: the
       * active scope + sync state sit on the left as the panel's identity, the
       * primary action (fetch/refresh) on the right, and the scope/branch
       * selects form the control row below. The nav rail already names the
       * panel, so there is no redundant "Git" title bar.
       */}
      <div className="border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]">
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
          <div
            className="flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--text-subtle)]"
            title={activeScopePath}
          >
            <StatusDot tone={scopeAppearanceTone(activeScopeAppearance.label)} label={activeScopeAppearance.label} />
            <span className="min-w-0 truncate text-[color:var(--text-default)]">{activeScopeAppearance.label}</span>
            <span className="shrink-0 text-[color:var(--text-disabled)]" aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{syncStatusLabel(branches)}</span>
          </div>
          <Tooltip content="Fetch remotes and refresh Git status" placement="bottom">
            <IconButton
              aria-label="Fetch remotes and refresh Git status"
              onClick={() => void handleFetch()}
              disabled={Boolean(busy)}
            >
              <RefreshGitIcon />
            </IconButton>
          </Tooltip>
        </div>
        <div className="space-y-1 px-3 pb-2">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2" title={activeScopePath}>
            <Select<string>
              ariaLabel="Git scope"
              items={
                scopeOptions.length === 0
                  ? [{ value: 'main', label: 'Current checkout' }]
                  : scopeOptions.map((scope) => ({
                      value: scope.id,
                      label: scope.label,
                      disabled: scope.missing || scope.locked || scope.prunable,
                    }))
              }
              value={activeScope?.id ?? 'main'}
              onChange={(next) => setActiveScopeId(next)}
              disabled={Boolean(busy) || scopeOptions.length <= 1}
              className="w-full"
            />
            <Tooltip content={activeScope?.kind === 'worktree' ? `Review diff against ${reviewDiffTarget.baseRef}` : 'Select a worktree to review its diff'} placement="bottom">
              <button
                type="button"
                onClick={() => void handleReviewDiff()}
                disabled={Boolean(busy) || activeScope?.kind !== 'worktree' || !repoRoot}
                className="h-6 rounded-md px-2 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]"
              >
                Review diff
              </button>
            </Tooltip>
          </div>
          <Select<string>
            ariaLabel="Current branch"
            items={
              branchOptions.length === 0
                ? [{ value: '', label: branches?.current ?? 'detached' }]
                : branchOptions.map((branch) => ({ value: branch.name, label: branch.name }))
            }
            value={branches?.current ?? ''}
            onChange={(next) => void handleSwitchBranch(next)}
            disabled={Boolean(busy) || branchOptions.length === 0}
            className="w-full"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3" role="tablist" aria-label="Git panel views">
          <GitPanelTab
            active={activeView === 'changes'}
            label="Changes"
            count={allEntries.length}
            onClick={() => setActiveView('changes')}
          />
          <GitPanelTab
            active={activeView === 'worktrees'}
            label="Worktrees"
            count={worktreeCount}
            onClick={() => setActiveView('worktrees')}
          />
          <GitPanelTab
            active={activeView === 'log'}
            label="Log"
            count={totalCommitCount}
            onClick={() => setActiveView('log')}
          />
          <GitPanelTab
            active={activeView === 'terminal'}
            label="Terminal"
            onClick={() => setActiveView('terminal')}
          />
        </div>

        {activeView === 'changes' ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {allEntries.length === 0 ? (
                <div className="py-2 text-[12px] text-[color:var(--text-subtle)]">Working tree clean</div>
              ) : (
                <>
                  <ConflictGroup
                    entries={conflictEntries}
                    busy={busy}
                    onOpenFile={handleOpenFile}
                    onResolve={handleResolveConflict}
                  />
                  {groups.map((group) => (
                    <ChangeGroup
                      key={group.title}
                      group={group}
                      busy={busy}
                      onOpenFile={handleOpenFile}
                    />
                  ))}
                </>
              )}
            </div>

            <CommitComposer
              busy={busy}
              commitMessage={commitMessage}
              message={message}
              readyToCommit={readyToCommit}
              stagedCount={stagedEntries.length}
              onCommit={handleCommit}
              onCommitMessageChange={setCommitMessage}
              onFetch={handleFetch}
              onPull={handlePull}
              onPush={handlePush}
              scopeLabel={activeScopeLabel}
              scopePath={activeScopePath}
            />
          </>
        ) : activeView === 'worktrees' ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <WorktreeManager
              workspaceId={workspaceId}
              repoRoot={mainRepoRoot ?? repoRoot}
              currentBranch={branches?.current ?? null}
              branchOptions={branchOptions.map((branch) => branch.name)}
              mode="tab"
              onChanged={refreshAll}
            />
          </div>
        ) : activeView === 'log' ? (
          <GitGraphView
            state={graph}
            currentBranch={branches?.current ?? null}
            detachedReturnBranch={detachedReturnBranch}
            actions={commitActions}
            onReturnToBranch={(branch) => void handleSwitchBranch(branch)}
            onLoadMore={() => void handleLoadMoreGraph()}
            loadingMore={loadingMoreGraph}
          />
        ) : (
          <GitTerminalView
            key={`${workspaceId}:${repoRoot}`}
            workspaceId={workspaceId}
            repoRoot={repoRoot}
            terminalId={`git-${workspaceId}-${terminalIdPart(activeScope?.id ?? repoRoot)}`}
          />
        )}
      </div>
    </div>
  )
}

// Mirrors the resting panel chrome (status header, control row, change list) so
// repository resolution reads as a quiet load rather than a content flash. The
// resting block colour is the raised surface; the shared shimmer sweeps it.
function GitPanelSkeleton(): JSX.Element {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-[color:var(--bg-surface)]">
      <span role="status" className="sr-only">
        Loading Git status…
      </span>
      <div aria-hidden="true" className="border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]">
        <div className="flex h-8 items-center justify-between gap-2 px-3">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* design-tokens-allow: skeleton placeholder for the scope StatusDot, not a live status dot */}
            <Skeleton className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--skeleton-shimmer-high)]" />
            <Skeleton className="h-3 w-28 rounded bg-[color:var(--skeleton-shimmer-high)]" />
          </div>
          <Skeleton className="h-5 w-5 shrink-0 rounded bg-[color:var(--skeleton-shimmer-high)]" />
        </div>
        <div className="flex items-center gap-2 px-3 pb-2">
          <Skeleton className="h-7 flex-1 rounded-md bg-[color:var(--skeleton-shimmer-high)]" />
          <Skeleton className="h-7 flex-1 rounded-md bg-[color:var(--skeleton-shimmer-high)]" />
        </div>
      </div>
      <div aria-hidden="true" className="flex-1 px-3 py-2">
        {[72, 58, 84, 46, 66].map((width, index) => (
          <div key={index} className="flex items-center gap-2 py-1.5">
            {/* design-tokens-allow: skeleton placeholder for a change-row StatusDot, not a live status dot */}
            <Skeleton className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--skeleton-shimmer-high)]" />
            <Skeleton className="h-3 rounded bg-[color:var(--skeleton-shimmer-high)]" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

function GitPanelTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] ${
        active
          ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
      }`}
    >
      <span>{label}</span>
      {typeof count === 'number' ? (
        <span className={active ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-disabled)]'}>{count}</span>
      ) : null}
    </button>
  )
}

function GitTerminalView({
  workspaceId,
  repoRoot,
  terminalId,
}: {
  workspaceId: string
  repoRoot: string
  terminalId: string
}) {
  return (
    <div className="min-h-0 flex-1 border-t border-[color:var(--bg-hover)] bg-[color:var(--bg-app)]">
      <PlainTerminalPanel
        workspaceId={workspaceId}
        terminalId={terminalId}
        cwdOverride={repoRoot}
        killOnUnmount
      />
    </div>
  )
}

function ConflictGroup({
  entries,
  busy,
  onOpenFile,
  onResolve,
}: {
  entries: GitStatusEntry[]
  busy: string | null
  onOpenFile: (entry: GitStatusEntry) => Promise<void>
  onResolve: (entry: GitStatusEntry) => void
}) {
  if (entries.length === 0) return null

  return (
    <section className="mb-4">
      <div className="mb-1 flex h-6 items-center justify-between gap-2">
        <div className="text-[12px] font-semibold text-[color:var(--tone-error)]">
          Conflicts ({entries.length})
        </div>
      </div>
      <div className="space-y-1">
        {entries.map((entry) => {
          const appearance = getGitStatusAppearance(entry.status)
          const pathParts = splitGitPath(entry.relativePath)
          const title = (
            <span className="flex min-w-0 items-baseline font-mono">
              {pathParts.directory ? (
                <>
                  <span className="min-w-0 shrink truncate opacity-60 [direction:rtl]">
                    {pathParts.directory}
                  </span>
                  <span className="shrink-0 opacity-60">/</span>
                </>
              ) : null}
              <span className={`min-w-0 max-w-full shrink-0 truncate font-semibold ${appearance.textClass}`}>{pathParts.filename}</span>
            </span>
          )
          return (
            <div key={`conflict:${entry.path}`} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <InboxRow
                  hideDot
                  title={title}
                  trailing={<span className="font-mono text-[10px] font-bold opacity-80">!</span>}
                  onSelect={() => void onOpenFile(entry)}
                  ariaLabel={`Open ${entry.relativePath}, conflicted`}
                />
              </div>
              <Tooltip content={`Resolve ${entry.relativePath}`}>
                <button
                  type="button"
                  onClick={() => onResolve(entry)}
                  disabled={Boolean(busy)}
                  className="h-6 shrink-0 rounded-md px-2 text-[11px] font-semibold text-[color:var(--tone-error)] transition-colors hover:bg-[color:var(--tone-error-soft)] disabled:opacity-30"
                  aria-label={`Resolve ${entry.relativePath}`}
                >
                  Resolve
                </button>
              </Tooltip>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ChangeGroup({
  group,
  busy,
  onOpenFile,
}: {
  group: GitChangeGroup
  busy: string | null
  onOpenFile: (entry: GitStatusEntry) => Promise<void>
}) {
  return (
    <section className="mb-4">
      <div className="mb-1 flex h-6 items-center justify-between gap-2">
        <div className="text-[12px] font-semibold text-[color:var(--text-strong)]">{group.title}</div>
        {group.bulkActions && group.entries.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            {group.bulkActions.map((bulkAction) => (
              <Tooltip key={bulkAction.title} content={bulkAction.title}>
                <button
                  type="button"
                  onClick={() => void bulkAction.action()}
                  disabled={Boolean(busy)}
                  className={`inline-flex h-6 shrink-0 items-center justify-center rounded-md px-2 text-[11px] font-semibold leading-none transition-colors disabled:opacity-30 ${
                    bulkAction.danger
                      ? 'text-[color:var(--tone-error)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)]'
                      : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                  }`}
                  aria-label={bulkAction.title}
                >
                  {bulkAction.label}
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </div>
      {group.entries.length === 0 ? (
        <div className="py-1.5 text-[11px] text-[color:var(--text-disabled)]">{group.empty}</div>
      ) : (
        <>
          <div className="space-y-1">
            {group.entries.map((entry) => {
              const appearance = getGitStatusAppearance(entry.status)
              const pathParts = splitGitPath(entry.relativePath)
              const statusWord = gitStatusWord(entry.status)
              // Status reads from the colour-coded filename (green added / amber
              // modified / red + strikethrough deleted) rather than a leading
              // dot, so the row stays a single status idiom.
              const title = (
                <span className="flex min-w-0 items-baseline font-mono">
                  {pathParts.directory ? (
                    <>
                      <span className="min-w-0 shrink truncate opacity-60 [direction:rtl]">
                        {pathParts.directory}
                      </span>
                      <span className="shrink-0 opacity-60">/</span>
                    </>
                  ) : null}
                  <span className={`min-w-0 max-w-full shrink-0 truncate ${appearance.textClass}`}>
                    {pathParts.filename}
                  </span>
                </span>
              )
              const trailing = appearance.badge ? (
                <span className="font-mono text-[10px] font-bold opacity-80">{appearance.badge}</span>
              ) : null
              return (
                <div key={`${group.title}:${entry.path}`} className="group/row flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <InboxRow
                      hideDot
                      title={title}
                      trailing={trailing}
                      onSelect={() => void onOpenFile(entry)}
                      ariaLabel={statusWord ? `Open ${entry.relativePath}, ${statusWord}` : `Open ${entry.relativePath}`}
                    />
                  </div>
                  <Tooltip content={group.actionTitle}>
                    <button
                      type="button"
                      onClick={() => void group.action(entry.path)}
                      disabled={Boolean(busy)}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[color:var(--text-muted)] opacity-70 transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] disabled:opacity-30 group-hover/row:opacity-100"
                      aria-label={`${group.actionTitle}: ${entry.relativePath}`}
                    >
                      <GitActionIcon kind={group.actionIcon} />
                    </button>
                  </Tooltip>
                  {group.secondaryAction ? (
                    <Tooltip content={group.secondaryAction.title}>
                      <button
                        type="button"
                        onClick={() => void group.secondaryAction?.action(entry)}
                        disabled={Boolean(busy)}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[color:var(--tone-error)] opacity-70 transition-colors hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)] focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[color:var(--tone-error)] disabled:opacity-30 group-hover/row:opacity-100"
                        aria-label={`${group.secondaryAction.title}: ${entry.relativePath}`}
                      >
                        <GitActionIcon kind={group.secondaryAction.icon} />
                      </button>
                    </Tooltip>
                  ) : null}
                </div>
              )
            })}
          </div>
          {group.omittedCount > 0 ? (
            <div className="mt-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-2 py-1.5 text-[11px] text-[color:var(--text-subtle)]">
              {group.omittedCount} more changes hidden to keep the panel responsive. Use Git CLI or stage/discard all for bulk actions.
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

function CommitComposer({
  busy,
  commitMessage,
  message,
  readyToCommit,
  stagedCount,
  onCommit,
  onCommitMessageChange,
  onFetch,
  onPull,
  onPush,
  scopeLabel,
  scopePath,
}: {
  busy: string | null
  commitMessage: string
  message: GitPanelMessage | null
  readyToCommit: boolean
  stagedCount: number
  onCommit: () => Promise<void>
  onCommitMessageChange: (value: string) => void
  onFetch: () => Promise<void>
  onPull: () => Promise<void>
  onPush: () => Promise<void>
  scopeLabel: string
  scopePath: string
}) {
  return (
    <section className="shrink-0 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-3">
      <div className="mb-2 min-w-0 text-[11px] text-[color:var(--text-subtle)]">
        <span className="font-medium text-[color:var(--text-muted)]">Commit scope</span>
        <span className="mx-1.5 text-[color:var(--text-disabled)]" aria-hidden="true">/</span>
        <span className="font-mono" title={scopePath}>{scopeLabel}</span>
      </div>
      <textarea
        value={commitMessage}
        onChange={(event) => onCommitMessageChange(event.target.value)}
        placeholder="Commit message"
        className="h-16 w-full resize-none rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] px-2.5 py-2 text-[12px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] transition-colors focus:border-[color:var(--border-strong)]"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] text-[color:var(--text-subtle)]">
          {stagedCount > 0 ? `${stagedCount} staged` : 'Nothing staged'}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void onFetch()}
            disabled={Boolean(busy)}
            className="h-8 rounded-md px-2.5 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-default disabled:text-[color:var(--text-disabled)] disabled:hover:bg-transparent"
          >
            Fetch
          </button>
          <button
            type="button"
            onClick={() => void onPull()}
            disabled={Boolean(busy)}
            className="h-8 rounded-md px-2.5 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-default disabled:text-[color:var(--text-disabled)] disabled:hover:bg-transparent"
          >
            Pull
          </button>
          <button
            type="button"
            onClick={() => void onPush()}
            disabled={Boolean(busy)}
            className="h-8 rounded-md px-2.5 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-default disabled:text-[color:var(--text-disabled)] disabled:hover:bg-transparent"
          >
            Push
          </button>
          <button
            type="button"
            onClick={() => void onCommit()}
            disabled={Boolean(busy) || !readyToCommit}
            className="h-8 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--text-strong)] px-3 text-[11px] font-semibold text-[color:var(--bg-surface-raised)] transition-colors hover:bg-[color:var(--bg-inverted-hover)] disabled:border-[color:var(--border-subtle)] disabled:bg-[color:var(--bg-hover)] disabled:text-[color:var(--text-disabled)]"
          >
            Commit
          </button>
        </div>
      </div>
      {message ? (
        <div
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`mt-2 max-h-20 overflow-y-auto rounded-md px-2.5 py-2 text-[11px] [overflow-wrap:anywhere] ${
            message.tone === 'error'
              ? 'border border-[color:var(--tone-error)] bg-[color:var(--tone-error-soft)] text-[color:var(--tone-error)]'
              : message.tone === 'success'
                ? 'bg-transparent px-0 py-0 text-[color:var(--text-muted)]'
                : 'bg-[color:var(--bg-hover)] text-[color:var(--text-muted)]'
          }`}
        >
          {message.text}
        </div>
      ) : null}
    </section>
  )
}
