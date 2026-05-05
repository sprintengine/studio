import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStatus } from '../../hooks/useGitStatus'
import { getGitScopeStatusAppearance, getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { focusOrAddFileTab, focusOrAddTerminalTab } from '../../utils/modelRegistry'
import { isImageFile } from '../../utils/files'
import WorktreeManager from '../worktree/WorktreeManager'

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

type GitHistoryState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: GitHistorySnapshot }
  | { status: 'error'; message: string }

type GitScopeKind = 'main' | 'worktree'

type GitPanelView = 'changes' | 'worktrees' | 'log'

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

function RefreshGitIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
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
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
        <path d="M8 3.25V12.75M4.25 8H11.75" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'unstage') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
        <path d="M4.25 8H11.75" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
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

function trimPath(pathValue: string): string {
  return pathValue.replace(/[\\/]+$/, '')
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return trimPath(a).toLowerCase() === trimPath(b).toLowerCase()
}

function basename(pathValue: string): string {
  const parts = trimPath(pathValue).split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? pathValue
}

function branchOrHeadLabel(branch: string | null, head: string | null): string {
  if (branch) return branch
  if (head) return head.slice(0, 8)
  return 'detached'
}

function scopeId(kind: GitScopeKind, pathValue: string): string {
  return `${kind}:${trimPath(pathValue).toLowerCase()}`
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
  const { repoRoot, status, refresh } = useGitStatus(activeRootPath)
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [history, setHistory] = useState<GitHistoryState>({ status: 'loading' })
  const [message, setMessage] = useState<GitPanelMessage | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<GitPanelView>('changes')

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

  const refreshHistory = useCallback(async () => {
    if (!repoRoot || typeof window.api.getGitHistory !== 'function') {
      setHistory({
        status: 'error',
        message: 'Restart the app to enable commit history.',
      })
      return
    }

    setHistory({ status: 'loading' })
    try {
      setHistory({ status: 'ready', snapshot: await window.api.getGitHistory(repoRoot, 50) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setHistory({
        status: 'error',
        message: message.includes("No handler registered for 'git:get-history'")
          ? 'Restart the app to enable commit history.'
          : 'Unable to load commits.',
      })
    }
  }, [repoRoot])

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshBranches(), refreshHistory(), refreshWorktreeScopes()])
  }, [refresh, refreshBranches, refreshHistory, refreshWorktreeScopes])

  useEffect(() => {
    void refreshBranches()
    void refreshHistory()
  }, [refreshBranches, refreshHistory])

  const statusEntries = useMemo(() => Object.values(status?.files ?? {}), [status])
  const stagedEntries = useMemo(
    () => sortedEntries(statusEntries.filter((entry) => entry.staged)),
    [statusEntries]
  )
  const unstagedEntries = useMemo(
    () => sortedEntries(statusEntries.filter((entry) => entry.unstaged)),
    [statusEntries]
  )
  const allEntries = useMemo(() => sortedEntries(statusEntries), [statusEntries])
  const branchOptions = branches?.branches ?? []
  const worktreeCount = scopeOptions.filter((scope) => scope.kind === 'worktree').length
  const commitCount = history.status === 'ready' ? history.snapshot.commits.length : 0
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
  const revertPath = (entry: GitStatusEntry) => {
    const confirmed = window.confirm(
      `Revert all changes to ${entry.relativePath} in ${activeScopeLabel}? This cannot be undone from Multicode.\n\nScope path: ${activeScopePath}`
    )
    if (!confirmed) return Promise.resolve(null)

    return runAction('Reverting file', () => window.api.revertGitPaths(repoRoot!, [entry.path]), 'Reverted file.')
  }
  const discardUnstagedChanges = () => {
    const confirmed = window.confirm(
      `Roll back all unstaged changes in ${activeScopeLabel}? This will discard unstaged edits and remove untracked files.\n\nScope path: ${activeScopePath}`
    )
    if (!confirmed) return Promise.resolve(null)

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
    await runAction('Pushing', () => window.api.pushGitBranch(repoRoot), 'Pushed branch.')
  }

  const handleSwitchBranch = async (branchName: string) => {
    if (!repoRoot || !branchName || branchName === branches?.current) return
    const checkedOutElsewhere = scopeOptions.find((scope) =>
      scope.branch === branchName && !samePath(scope.path, repoRoot)
    )
    if (checkedOutElsewhere) {
      const confirmed = window.confirm(
        `Branch "${branchName}" is already checked out in another worktree.\n\n${checkedOutElsewhere.path}\n\nGit may refuse to switch to it here. Continue?`
      )
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
      workspace?.swarmContext?.statePath,
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
      <div className="flex h-full items-center justify-center bg-[#0d0e11] px-6 text-center text-[12px] text-[#5a5a63]">
        Open a folder to use Git controls.
      </div>
    )
  }

  if (!repoRoot) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0d0e11] px-6 text-center text-[12px] text-[#5a5a63]">
        This folder is not a Git repository.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0d0e11] text-[#d7d7dc]">
      <div className="border-b border-[#1b1c21] bg-[#101115]">
        <div className="flex min-h-[72px] shrink-0 items-center justify-between gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <select
                value={activeScope?.id ?? 'main'}
                onChange={(event) => setActiveScopeId(event.target.value)}
                disabled={Boolean(busy) || scopeOptions.length <= 1}
                className="block h-6 max-w-full rounded-md border border-[#25262c] bg-[#090a0c] px-1.5 text-[11px] font-semibold text-[#d7d7dc] outline-none transition-colors hover:border-[#303139] focus:border-[#4b5563] disabled:opacity-50"
                aria-label="Git scope"
                title={activeScopePath}
              >
                {scopeOptions.length === 0 ? (
                  <option value="main">Current checkout</option>
                ) : (
                  scopeOptions.map((scope) => (
                    <option key={scope.id} value={scope.id} disabled={scope.missing || scope.locked || scope.prunable}>
                      {scope.label}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                onClick={() => void handleReviewDiff()}
                disabled={Boolean(busy) || activeScope?.kind !== 'worktree' || !repoRoot}
                className="h-6 rounded-md px-2 text-[11px] font-semibold text-[#8a8a92] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#8a8a92]"
                title={activeScope?.kind === 'worktree' ? `Review diff against ${reviewDiffTarget.baseRef}` : 'Select a worktree to review its diff'}
              >
                Review Diff
              </button>
            </div>
            <select
              value={branches?.current ?? ''}
              onChange={(event) => void handleSwitchBranch(event.target.value)}
              disabled={Boolean(busy) || branchOptions.length === 0}
              className="block h-5 max-w-full rounded-md border border-transparent bg-transparent px-1 font-mono text-[12px] font-semibold text-[#ececee] outline-none transition-colors hover:bg-[#1a1b20] focus:border-[#303139] focus:bg-[#090a0c] disabled:opacity-50"
              aria-label="Current branch"
            >
              {branchOptions.length === 0 ? (
                <option value="">{branches?.current ?? 'detached'}</option>
              ) : null}
              {branchOptions.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.name}
                </option>
              ))}
            </select>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-[#6f7480]">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeScopeAppearance.dotClass}`} aria-hidden="true" />
              <span className="shrink-0">{activeScopeAppearance.label}</span>
              <span className="shrink-0 text-[#3f444d]" aria-hidden="true">/</span>
              <span className="truncate">{syncStatusLabel(branches)}</span>
              <span className="shrink-0 text-[#3f444d]" aria-hidden="true">/</span>
              <span className="truncate font-mono" title={activeScopePath}>{activeScopePath}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={Boolean(busy)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#838896] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#838896]"
            title="Refresh Git status"
            aria-label="Refresh Git status"
          >
            <RefreshGitIcon />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[#1b1c21] bg-[#0d0e11] px-3" role="tablist" aria-label="Git panel views">
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
            count={commitCount}
            onClick={() => setActiveView('log')}
          />
        </div>

        {activeView === 'changes' ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {allEntries.length === 0 ? (
                <div className="py-2 text-[12px] text-[#6f7480]">Working tree clean</div>
              ) : (
                groups.map((group) => (
                  <ChangeGroup
                    key={group.title}
                    group={group}
                    busy={busy}
                    onOpenFile={handleOpenFile}
                  />
                ))
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
        ) : (
          <GitLogView history={history} />
        )}
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
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-1 focus:ring-[#303139] ${
        active
          ? 'bg-[#1a1b20] text-[#ececee]'
          : 'text-[#8a8a92] hover:bg-[#15161a] hover:text-[#d7d7dc]'
      }`}
    >
      <span>{label}</span>
      <span className={active ? 'text-[#9a9aa2]' : 'text-[#5a5a63]'}>{count}</span>
    </button>
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
        <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">{group.title}</div>
        {group.bulkActions && group.entries.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            {group.bulkActions.map((bulkAction) => (
              <button
                key={bulkAction.title}
                type="button"
                onClick={() => void bulkAction.action()}
                disabled={Boolean(busy)}
                className={`inline-flex h-6 shrink-0 items-center justify-center rounded-md px-2 text-[11px] font-semibold leading-none transition-colors disabled:opacity-30 ${
                  bulkAction.danger
                    ? 'text-[#b97074] hover:bg-[#2a1518] hover:text-[#ff8a8e]'
                    : 'text-[#8a8a92] hover:bg-[#1a1b20] hover:text-[#ececee]'
                }`}
                title={bulkAction.title}
                aria-label={bulkAction.title}
              >
                {bulkAction.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {group.entries.length === 0 ? (
        <div className="py-1.5 text-[11px] text-[#5a5a63]">{group.empty}</div>
      ) : (
        <>
          <div className="space-y-1">
            {group.entries.map((entry) => {
              const appearance = getGitStatusAppearance(entry.status)
              const pathParts = splitGitPath(entry.relativePath)
              return (
                <div
                  key={`${group.title}:${entry.path}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => void onOpenFile(entry)}
                  onKeyDown={(event) => {
                    if (event.currentTarget !== event.target) return
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    void onOpenFile(entry)
                  }}
                  className="group flex min-h-[26px] items-center gap-2 rounded-md px-2 py-1 text-[12px] text-[#9a9aa2] transition-colors hover:bg-[#15161a] hover:text-[#ececee]"
                  title={`Open ${entry.relativePath}`}
                >
                  <span className={`flex min-w-0 flex-1 items-baseline font-mono ${appearance.textClass}`}>
                    {pathParts.directory ? (
                      <>
                        <span className="min-w-0 shrink truncate opacity-60 [direction:rtl]">
                          {pathParts.directory}
                        </span>
                        <span className="shrink-0 opacity-60">/</span>
                      </>
                    ) : null}
                    <span className="min-w-0 max-w-full shrink-0 truncate">{pathParts.filename}</span>
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      void group.action(entry.path)
                    }}
                    disabled={Boolean(busy)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#8a8a92] opacity-70 transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[#303139] disabled:opacity-30 group-hover:opacity-100"
                    title={group.actionTitle}
                    aria-label={`${group.actionTitle}: ${entry.relativePath}`}
                  >
                    <GitActionIcon kind={group.actionIcon} />
                  </button>
                  {group.secondaryAction ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        void group.secondaryAction?.action(entry)
                      }}
                      disabled={Boolean(busy)}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#b97074] opacity-70 transition-colors hover:bg-[#2a1518] hover:text-[#ff8a8e] focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[#713036] disabled:opacity-30 group-hover:opacity-100"
                      title={group.secondaryAction.title}
                      aria-label={`${group.secondaryAction.title}: ${entry.relativePath}`}
                    >
                      <GitActionIcon kind={group.secondaryAction.icon} />
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
          {group.omittedCount > 0 ? (
            <div className="mt-2 rounded-md border border-[#24252b] bg-[#111216] px-2 py-1.5 text-[11px] text-[#6f7480]">
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
  onPush: () => Promise<void>
  scopeLabel: string
  scopePath: string
}) {
  return (
    <section className="shrink-0 border-t border-[#1b1c21] bg-[#101115] px-3 py-3">
      <div className="mb-2 min-w-0 text-[10px] text-[#6f7480]">
        <span className="font-semibold uppercase tracking-[0.08em] text-[#8a8f9b]">Commit scope</span>
        <span className="mx-1.5 text-[#3f444d]" aria-hidden="true">/</span>
        <span className="font-mono" title={scopePath}>{scopeLabel}</span>
      </div>
      <textarea
        value={commitMessage}
        onChange={(event) => onCommitMessageChange(event.target.value)}
        placeholder="Commit message"
        className="h-16 w-full resize-none rounded-md border border-[#1f2025] bg-[#090a0c] px-2.5 py-2 text-[12px] text-[#ececee] outline-none placeholder:text-[#5a5a63] transition-colors focus:border-[#3a3d49]"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] text-[#6f7480]">
          {stagedCount > 0 ? `${stagedCount} staged` : 'Nothing staged'}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void onPush()}
            disabled={Boolean(busy)}
            className="h-8 rounded-md px-2.5 text-[11px] font-semibold text-[#8a8f9b] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:cursor-default disabled:text-[#4f535c] disabled:hover:bg-transparent"
          >
            Push
          </button>
          <button
            type="button"
            onClick={() => void onCommit()}
            disabled={Boolean(busy) || !readyToCommit}
            className="h-8 rounded-md border border-[#3a3d49] bg-[#ececee] px-3 text-[11px] font-semibold text-[#111216] transition-colors hover:bg-white disabled:border-[#24252b] disabled:bg-[#15161a] disabled:text-[#5a5a63]"
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
              ? 'border border-[#713036] bg-[#311417] text-[#ff8a8e]'
              : message.tone === 'success'
                ? 'bg-transparent px-0 py-0 text-[#8a8f9b]'
                : 'bg-[#15161a] text-[#9a9aa2]'
          }`}
        >
          {message.text}
        </div>
      ) : null}
    </section>
  )
}

function GitLogView({
  history,
}: {
  history: GitHistoryState
}) {
  const commits = history.status === 'ready' ? history.snapshot.commits : []

  if (history.status === 'loading') {
    return <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[11px] text-[#5a5a63]">Loading commits...</div>
  }

  if (history.status === 'error') {
    return <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[11px] text-[#8a8a92]">{history.message}</div>
  }

  if (commits.length === 0) {
    return <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[11px] text-[#5a5a63]">No commits yet</div>
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="mb-2 flex h-6 items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">Log</div>
        <div className="text-[10px] text-[#5a5a63]">{commits.length} recent</div>
      </div>
      <div className="space-y-1.5">
        {commits.map((commit) => (
          <GitLogCommitRow
            key={commit.hash}
            commit={commit}
          />
        ))}
      </div>
    </section>
  )
}

function GitLogCommitRow({ commit }: { commit: GitCommit }) {
  const content = (
    <>
      <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full border border-[#3a3d49]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[#d7d7dc] group-hover:text-[#ececee]">{commit.subject}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-[#5a5a63]">
          <span className="font-mono text-[#8a8a92]">{commit.shortHash}</span>
          <span>{commit.date}</span>
          <span className="min-w-0 truncate">{commit.author}</span>
        </div>
      </div>
      {commit.refs.length > 0 ? (
        <span className="mt-0.5 max-w-[76px] shrink-0 truncate rounded-full bg-[#15161a] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[#8a8a92]">
          {commit.refs[0].replace(/^HEAD -> /, '')}
        </span>
      ) : null}
    </>
  )

  const className = `group flex min-h-[46px] items-start gap-2 rounded-md px-2 py-2 text-[12px] text-[#9a9aa2] transition-colors ${
    commit.commitWebUrl ? 'hover:bg-[#15161a] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139]' : ''
  }`

  if (commit.commitWebUrl) {
    return (
      <a
        href={commit.commitWebUrl}
        target="_blank"
        rel="noreferrer"
        className={className}
        title={`Open ${commit.shortHash} on GitHub`}
        aria-label={`Open commit ${commit.shortHash} on GitHub`}
      >
        {content}
      </a>
    )
  }

  return (
    <div className={className} title={commit.subject}>
      {content}
    </div>
  )
}
