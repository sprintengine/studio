import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStatus } from '../../hooks/useGitStatus'
import { getGitScopeStatusAppearance, getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { focusOrAddGitConflictTab, focusOrAddTerminalTab } from '../../utils/modelRegistry'
import { isImageFile } from '../../utils/files'
import { openDiffWindow } from '../auxWindows/openDiffWindow'
import { openFileSurface } from '../../utils/openFileSurface'
import { basename, samePath, trimPath } from '../../utils/paths'
import {
  fileExplorerSelectionFromVerticalRange,
  fileExplorerSelectionRange,
} from '../../utils/fileExplorerSelection'
import { findHealthyWorktreeScope, resolveWorkspaceWorktrees } from '../../utils/workspaceWorktree'
import WorktreeManager from '../worktree/WorktreeManager'
import PlainTerminalPanel from './PlainTerminalPanel'
import { GhostButton, IconButton, InboxRow, InlineNotice, PanelHeader, RefreshIcon, Select, Skeleton, Tooltip, type LifecycleState } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { GitGraphView, type GitCommitActions, type GitGraphState, type GitMergeTarget } from './GitGraphView'
import type { GitPanelView } from '../../types/workspace'

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
  // Which diff the viewer shows for rows in this group: the Staged group shows
  // HEAD↔index, the Unstaged group index↔worktree. A partially-staged file
  // appears in both groups, so the group — not the entry — decides the scope.
  scope: 'staged' | 'unstaged'
  empty: string
  actionTitle: string
  actionIcon: GitActionIconKind
  secondaryAction?: {
    title: string
    icon: GitActionIconKind
  }
  bulkActions?: GitBulkAction[]
  entries: GitStatusEntry[]
  omittedCount: number
}

type GitActionIconKind = 'stage' | 'unstage' | 'revert'

// Selection key for a change row. A partially-staged file shows in both the
// Staged and Unstaged groups, so path alone is ambiguous; the scope keeps the
// two rows independently selectable. The NUL separator can't collide with a path.
function changeSelectionKey(scope: 'staged' | 'unstaged', path: string): string {
  return `${scope}\u0000${path}`
}

type GitBulkAction = {
  label: string
  title: string
  danger?: boolean
  action: () => Promise<unknown>
}

type GitScopeKind = 'main' | 'worktree'

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

const OPERATION_LABELS: Record<GitRepoOperation, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
}

const MAX_RENDERED_GIT_CHANGES_PER_GROUP = 500
const GIT_PANEL_AUTO_REFRESH_MS = 10_000
const GIT_GRAPH_PAGE_SIZE = 200
const STANDARD_BASE_BRANCHES = ['main', 'master', 'develop', 'trunk']

// Incoming (down = pull) / outgoing (up = push) arrow, matching the IDE sync
// idiom. Pairs with the count + accessible label on its button.
function SyncArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-xs" fill="none">
      <path
        d={direction === 'down' ? 'M8 3.25v9.5m0 0 3.25-3.25M8 12.75 4.75 9.5' : 'M8 12.75v-9.5m0 0 3.25 3.25M8 3.25 4.75 6.5'}
        stroke="currentColor"
        strokeWidth="1.4"
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

/**
 * Scope id for a project's own checkout. The workspace's OWN project keeps the bare
 * `main` it has always had — that id is the panel's default and is persisted in
 * every existing workspace's Git view state, so it must not be re-keyed — while
 * another project a run declared gets a path-keyed id of its own. Without that, two
 * projects' checkouts would share one id, and with it the per-scope commit draft: a
 * message typed against one project's checkout would reappear in the other's.
 *
 * Keyed on which project it is, NOT on whether the root matches the workspace
 * folder: a workspace opened at a subdirectory of its repo has a git root above
 * that folder, and is still its own project.
 */
function mainScopeIdFor(repoRoot: string, isPrimaryProject: boolean): string {
  return isPrimaryProject ? 'main' : scopeId('main', repoRoot)
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

// Scope health is earned, not decorated: a healthy checkout shows no mark (the
// old always-on green "Ready" dot was noise). Only the exceptional states surface
// a shape-coded glyph, matching the worktree list.
function scopeHealthGlyph(label: string): { state: LifecycleState; label: string } | null {
  if (label === 'Missing') return { state: 'failed', label: 'Missing' }
  if (label === 'Prunable') return { state: 'archived', label: 'Prunable' }
  if (label === 'Locked') return { state: 'paused', label: 'Locked' }
  return null
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

// Resting sync text only. Divergence (ahead/behind) is carried by the Pull/Push
// affordances so the count never appears twice; this line states the calm states
// the buttons can't (checking / no upstream / in sync).
function branchSyncSummary(branches: GitBranchSnapshot | null, hasUpstream: boolean): string {
  if (!branches) return 'Checking branch'
  if (!hasUpstream) return 'No upstream'
  if (!branches.ahead && !branches.behind) return 'Up to date'
  return ''
}

// Per-repo-root caches of the last loaded branches / commit graph / worktree
// scopes. Module-level so they survive a GitPanel unmount: switching workspaces
// within the same repo seeds these synchronously for an instant render, then the
// normal background refresh reconciles — instead of flashing the empty/loading
// state on every mount (the "Git loads again on switch" complaint). Only
// useGitStatus's status snapshot was shared before; these three were not.
// Cached values are shown immediately but never treated as truth: every mount
// still kicks a fresh fetch that overwrites both state and cache.
const gitBranchCache = new Map<string, GitBranchSnapshot>()
const gitGraphCache = new Map<string, { state: GitGraphState; limit: number }>()
const gitWorktreeScopeCache = new Map<string, GitScopeOption[]>()

function gitRepoCacheKey(repoRoot: string): string {
  return repoRoot.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

export default function GitPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
  const folderPath = workspace?.folderPath ?? null
  // For a worktree-backed workspace (a sprint run worktree, or a worktree opened
  // as a workspace) the Git view should resolve to the worktree's branch, not the
  // parent project. The worktree is a real `git worktree`, so it already shows up
  // as a scope below; this drives the *default* scope selection toward it.
  //
  // A sprint spanning projects (MC-1610) is backed by one worktree per project, so
  // this is a list: the project picker chooses which entry the panel is looking at,
  // and everything below — scopes, status, staging, commit — resolves through that
  // one project exactly as it always did. A run in one project yields one entry and
  // the picker never appears.
  const workspaceWorktrees = useMemo(
    () => (workspace ? resolveWorkspaceWorktrees(workspace) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace?.folderPath, workspace?.worktree, workspace?.sprintEngineState?.vcs],
  )
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null)
  // Entry zero is the primary project: the default view, and the answer whenever a
  // selected project drops out of the run's declared list.
  const activeRepoEntry =
    workspaceWorktrees.find((entry) => entry.repoId === activeRepoId) ?? workspaceWorktrees[0] ?? null
  // Whether the panel is looking at the workspace's own project — true for every
  // workspace that is not a run spanning projects, which is what keeps their scope
  // ids (and the commit drafts keyed by them) exactly as they were.
  const activeRepoIsPrimary = !activeRepoEntry || activeRepoEntry === workspaceWorktrees[0]
  const worktreeGitRoot = activeRepoEntry?.gitRoot ?? null
  const worktreeBranch = activeRepoEntry?.branch ?? null
  // The checkout whose worktrees are enumerated below: the selected project's own
  // root. For the workspace's own project — and for every single-project run — that
  // IS the workspace folder, so this resolves exactly what it always did.
  const activeRepoRoot = activeRepoEntry?.repoRoot ?? folderPath
  const mainGit = useGitStatus(activeRepoRoot)
  const mainRepoRoot = mainGit.repoRoot
  const setGitPanelState = useWorkspaceStore((s) => s.setGitPanelState)
  const setGitCommitDraft = useWorkspaceStore((s) => s.setGitCommitDraft)
  const clearGitCommitDraft = useWorkspaceStore((s) => s.clearGitCommitDraft)
  // Snapshot the persisted Git view state once at mount so the active tab, scope,
  // and per-scope commit drafts restore after a reload/restart. Read via getState
  // (not a subscription) so it does not re-render the panel on later writes.
  const initialGitPanelState = useMemo(
    () => useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.gitPanelState ?? null,
    [workspaceId],
  )
  const [scopeOptions, setScopeOptions] = useState<GitScopeOption[]>([])
  const [activeScopeId, setActiveScopeId] = useState(() =>
    initialGitPanelState?.activeScopeId
    ?? (worktreeGitRoot ? scopeId('worktree', worktreeGitRoot) : 'main')
  )
  const activeScope = useMemo(() => {
    const byId = scopeOptions.find((scope) => scope.id === activeScopeId)
    if (byId) return byId
    // The computed worktree scope id can miss the listed one when git's
    // realpath-resolved path diverges from the joined path (symlinked roots);
    // recover via path-or-branch match so a worktree-backed workspace defaults to
    // its worktree, not the parent.
    return findHealthyWorktreeScope(scopeOptions, worktreeGitRoot, worktreeBranch) ?? scopeOptions[0] ?? null
  }, [activeScopeId, scopeOptions, worktreeGitRoot, worktreeBranch])
  // Before scopes finish loading, still resolve to the worktree (not the parent)
  // for a worktree-backed workspace so the first paint isn't the wrong diff.
  const activeRootPath = activeScope?.path ?? worktreeGitRoot ?? folderPath
  // True once the user (or a restored persisted choice) explicitly picked a scope,
  // so the worktree auto-default never overrides an intentional 'main' selection.
  const userSelectedScopeRef = useRef(Boolean(initialGitPanelState?.activeScopeId))
  const { repoRoot, status, repoState, refresh } = useGitStatus(activeRootPath)
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [graph, setGraph] = useState<GitGraphState>({ status: 'loading' })
  const [loadingMoreGraph, setLoadingMoreGraph] = useState(false)
  const [message, setMessage] = useState<GitPanelMessage | null>(null)
  const [commitMessage, setCommitMessage] = useState(() =>
    initialGitPanelState
      ? initialGitPanelState.commitDraftsByScopeId[initialGitPanelState.activeScopeId] ?? ''
      : '',
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<GitPanelView>(() => initialGitPanelState?.activeView ?? 'changes')
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
      id: mainScopeIdFor(mainRepoRoot, activeRepoIsPrimary),
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

      const scopes = [mainScope, ...worktreeScopes]
      setScopeOptions(scopes)
      gitWorktreeScopeCache.set(gitRepoCacheKey(mainRepoRoot), scopes)
    } catch {
      setScopeOptions([fallbackMainScope])
    }
  }, [mainRepoRoot, activeRepoIsPrimary])

  useEffect(() => {
    // Seed worktree scopes from the per-repo cache for an instant render when
    // returning to a repo we've already enumerated, then refresh in background.
    if (mainRepoRoot) {
      const cached = gitWorktreeScopeCache.get(gitRepoCacheKey(mainRepoRoot))
      if (cached) setScopeOptions(cached)
    }
    void refreshWorktreeScopes()
  }, [mainRepoRoot, refreshWorktreeScopes])

  useEffect(() => {
    if (scopeOptions.length === 0) return
    // Prefer this workspace's own (healthy) worktree scope by default (a sprint
    // run worktree, or a worktree opened as a workspace), falling back to main.
    // Excluding missing/locked/prunable here is what prevents an update loop with
    // the validity-reset effect below: a stale/prunable worktree resolves to null
    // and stays on main instead of being re-selected every tick.
    const desiredWorktreeScope = findHealthyWorktreeScope(scopeOptions, worktreeGitRoot, worktreeBranch)
    // The selected project's own checkout — the fallback when its worktree is not
    // usable. `scopeOptions` is always this project's, so entry zero is its main
    // scope; naming it by id keeps a sibling project off the primary's bare `main`.
    const mainScope = scopeOptions.find((scope) => scope.kind === 'main') ?? scopeOptions[0]
    if (scopeOptions.some((scope) => scope.id === activeScopeId)) {
      // Auto-upgrade the initial main default to the worktree once it appears
      // (the sprint's vcs can populate a tick after mount), but never override an
      // explicit user/persisted choice — main stays selectable.
      if (
        !userSelectedScopeRef.current
        && desiredWorktreeScope
        && desiredWorktreeScope.id !== mainScope?.id
        && activeScopeId === mainScope?.id
      ) {
        setActiveScopeId(desiredWorktreeScope.id)
      }
      return
    }
    // Switching projects lands here: the previous project's scope id is not in this
    // project's list, so the panel re-defaults to this project's worktree.
    setActiveScopeId(desiredWorktreeScope?.id ?? mainScope?.id ?? 'main')
  }, [activeScopeId, scopeOptions, worktreeGitRoot, worktreeBranch])

  useEffect(() => {
    if (!activeScope || activeScope.kind === 'main') return
    if (!activeScope.missing && !activeScope.locked && !activeScope.prunable) return
    setActiveScopeId('main')
  }, [activeScope])

  // Persist the active tab + scope (low-frequency, written directly). If a
  // restored scope no longer exists, the reset effects above flip it to 'main'
  // and this writes the corrected value back. Skip while the state is still the
  // default and no record exists yet, so merely opening the panel does not write
  // a default record for an untouched workspace (the normalizers keep absent
  // state undefined; a no-op mount write would defeat that).
  useEffect(() => {
    const isDefault = activeView === 'changes' && activeScopeId === 'main'
    const hasRecord = Boolean(
      useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.gitPanelState,
    )
    if (isDefault && !hasRecord) return
    setGitPanelState(workspaceId, { activeView, activeScopeId })
  }, [activeView, activeScopeId, workspaceId, setGitPanelState])

  // Per-scope commit-message drafts. The live `commitMessage` belongs to
  // `draftScopeRef`; a debounce keeps per-keystroke writes off the registry
  // serialize path (and still fires on a layer switch, which does not unmount).
  // Switching scope flushes the outgoing draft and loads the incoming one so a
  // half-written message never bleeds across worktrees.
  const commitMessageRef = useRef(commitMessage)
  commitMessageRef.current = commitMessage
  const draftScopeRef = useRef(activeScopeId)
  const commitDraftTimerRef = useRef<number | null>(null)
  const handleCommitMessageChange = useCallback(
    (text: string) => {
      setCommitMessage(text)
      const scopeId = draftScopeRef.current
      if (commitDraftTimerRef.current) window.clearTimeout(commitDraftTimerRef.current)
      commitDraftTimerRef.current = window.setTimeout(() => {
        setGitCommitDraft(workspaceId, scopeId, text)
      }, 400)
    },
    [workspaceId, setGitCommitDraft],
  )
  useEffect(() => {
    if (draftScopeRef.current === activeScopeId) return
    // Flush the outgoing scope's text (commitMessage still holds it here), then
    // swap in the incoming scope's persisted draft.
    if (commitDraftTimerRef.current) {
      window.clearTimeout(commitDraftTimerRef.current)
      commitDraftTimerRef.current = null
    }
    setGitCommitDraft(workspaceId, draftScopeRef.current, commitMessageRef.current)
    const incoming =
      useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.gitPanelState
        ?.commitDraftsByScopeId[activeScopeId] ?? ''
    setCommitMessage(incoming)
    draftScopeRef.current = activeScopeId
  }, [activeScopeId, workspaceId, setGitCommitDraft])
  useEffect(() => {
    return () => {
      if (commitDraftTimerRef.current) window.clearTimeout(commitDraftTimerRef.current)
      setGitCommitDraft(workspaceId, draftScopeRef.current, commitMessageRef.current)
    }
  }, [workspaceId, setGitCommitDraft])

  const refreshBranches = useCallback(async () => {
    if (!repoRoot || typeof window.api.getGitBranches !== 'function') {
      setBranches(null)
      return
    }

    try {
      const next = await window.api.getGitBranches(repoRoot)
      setBranches(next)
      gitBranchCache.set(gitRepoCacheKey(repoRoot), next)
    } catch {
      setBranches(null)
    }
  }, [repoRoot])

  const refreshStashes = useCallback(async () => {
    if (!repoRoot || typeof window.api.listGitStashes !== 'function') {
      setStashes([])
      return
    }

    try {
      const snapshot = await window.api.listGitStashes(repoRoot)
      setStashes(snapshot.stashes)
    } catch {
      setStashes([])
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
      const nextGraph: GitGraphState = { status: 'ready', snapshot }
      setGraph(nextGraph)
      gitGraphCache.set(gitRepoCacheKey(repoRoot), { state: nextGraph, limit: graphLimitRef.current })
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
        await Promise.all([refresh(), refreshBranches(), refreshStashes(), refreshGraph(shouldShowHistoryLoading), refreshWorktreeScopes()])

        const queuedShowHistoryLoading = refreshAllQueuedHistoryLoadingRef.current
        if (queuedShowHistoryLoading === null) break
        shouldShowHistoryLoading = queuedShowHistoryLoading
      }
    } finally {
      refreshAllInFlightRef.current = false
    }
  }, [refresh, refreshBranches, refreshStashes, refreshGraph, refreshWorktreeScopes])

  useEffect(() => {
    // Reset graph pagination whenever the scope/repo changes.
    graphLimitRef.current = GIT_GRAPH_PAGE_SIZE
    // Seed branches + graph from the per-repo cache so a repo we've loaded
    // before renders instantly; then refresh in the background, skipping the
    // graph loading flash when we already showed a cached graph.
    const cachedGraph = repoRoot ? gitGraphCache.get(gitRepoCacheKey(repoRoot)) : undefined
    if (repoRoot) {
      const cachedBranches = gitBranchCache.get(gitRepoCacheKey(repoRoot))
      if (cachedBranches) setBranches(cachedBranches)
      if (cachedGraph) {
        setGraph(cachedGraph.state)
        graphLimitRef.current = cachedGraph.limit
      }
    }
    void refreshBranches()
    void refreshStashes()
    void refreshGraph(!cachedGraph)
  }, [repoRoot, refreshBranches, refreshStashes, refreshGraph])

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
  const scopeHealth = scopeHealthGlyph(activeScopeAppearance.label)
  const currentBranchInfo = branchOptions.find((branch) => branch.current) ?? null
  const upstreamLabel = currentBranchInfo?.upstream ?? null
  const hasUpstream = Boolean(upstreamLabel)
  const ahead = branches?.ahead ?? 0
  const behind = branches?.behind ?? 0
  const syncSummary = branchSyncSummary(branches, hasUpstream)
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
      // Refresh on failure too: an operation that stopped on conflicts (merge,
      // rebase, cherry-pick, stash pop…) has still changed the working tree.
      await refreshAll()
      return result
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
      return null
    } finally {
      setBusy(null)
    }
  }

  const stagePaths = (paths: string[]) =>
    runAction(
      'Staging files',
      () => window.api.stageGitPaths(repoRoot!, paths),
      paths.length > 1 ? `Staged ${paths.length} files.` : 'Staged file.'
    )
  const unstagePaths = (paths: string[]) =>
    runAction(
      'Unstaging files',
      () => window.api.unstageGitPaths(repoRoot!, paths),
      paths.length > 1 ? `Unstaged ${paths.length} files.` : 'Unstaged file.'
    )
  const revertEntries = async (entries: GitStatusEntry[]) => {
    // A partially-staged file appears in both change groups, so the same path can
    // arrive twice from a cross-group selection; revert each path once.
    const seen = new Set<string>()
    const unique = entries.filter((entry) => {
      if (seen.has(entry.path)) return false
      seen.add(entry.path)
      return true
    })
    if (unique.length === 0) return null
    const many = unique.length > 1
    const confirmed = await dialog.confirm({
      title: many ? `Revert ${unique.length} files?` : `Revert ${unique[0].relativePath}?`,
      body: (
        <>
          This reverts every change to{' '}
          {many ? `these ${unique.length} files` : unique[0].relativePath} in {activeScopeLabel}. The action
          cannot be undone from Multicode.
          <div className="mt-2 font-mono text-[12px] text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
        </>
      ),
      confirmLabel: many ? 'Revert files' : 'Revert file',
      tone: 'danger',
    })
    if (!confirmed) return null

    return runAction(
      'Reverting files',
      () => window.api.revertGitPaths(repoRoot!, unique.map((entry) => entry.path)),
      many ? `Reverted ${unique.length} files.` : 'Reverted file.'
    )
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
      scope: 'staged',
      empty: 'No staged changes',
      actionTitle: 'Unstage this file',
      actionIcon: 'unstage',
      secondaryAction: {
        title: 'Revert this file',
        icon: 'revert',
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
      scope: 'unstaged',
      empty: 'No unstaged changes',
      actionTitle: 'Stage this file',
      actionIcon: 'stage',
      secondaryAction: {
        title: 'Revert this file',
        icon: 'revert',
      },
      bulkActions: [
        {
          label: 'Stage All',
          title: 'Stage all changes',
          action: () => runAction('Staging all', () => window.api.stageGitPaths(repoRoot!, []), 'Staged all changes.'),
        },
        {
          label: 'Stash',
          title: 'Stash all changes (staged, unstaged, and untracked)',
          action: () => handleStashPush(),
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

  // --- Change-row selection (multi-select + drag marquee) --------------------
  // Mirrors the FileExplorer selection model so batch stage/unstage/revert works
  // the same way. A partially-staged file appears in both groups, so selection is
  // keyed by scope+path (not path alone) to keep the two rows independent.
  const selectableRows = useMemo<Array<{ key: string; scope: 'staged' | 'unstaged'; entry: GitStatusEntry }>>(
    () => [
      ...stagedEntries
        .slice(0, MAX_RENDERED_GIT_CHANGES_PER_GROUP)
        .map((entry) => ({ key: changeSelectionKey('staged', entry.path), scope: 'staged' as const, entry })),
      ...unstagedEntries
        .slice(0, MAX_RENDERED_GIT_CHANGES_PER_GROUP)
        .map((entry) => ({ key: changeSelectionKey('unstaged', entry.path), scope: 'unstaged' as const, entry })),
    ],
    [stagedEntries, unstagedEntries]
  )
  const selectableRowsRef = useRef(selectableRows)
  const changeRowNodesRef = useRef<Record<string, HTMLElement | null>>({})
  const selectionAnchorKeyRef = useRef<string | null>(null)
  const changeDragRef = useRef<{ startY: number } | null>(null)
  const changeDragCompletedRef = useRef(false)
  const [selectedChangeKeys, setSelectedChangeKeys] = useState<Set<string>>(() => new Set())

  // Keep the geometry snapshot fresh and drop selection for rows that vanished
  // (committed, staged away, refreshed) so stale keys never drive a batch action.
  useEffect(() => {
    selectableRowsRef.current = selectableRows
    setSelectedChangeKeys((current) => {
      if (current.size === 0) return current
      const valid = new Set(selectableRows.map((row) => row.key))
      const next = new Set<string>()
      for (const key of current) if (valid.has(key)) next.add(key)
      return next.size === current.size ? current : next
    })
  }, [selectableRows])

  useEffect(() => {
    const updateDragSelection = (clientY: number) => {
      if (!changeDragRef.current) return
      const bounds = selectableRowsRef.current
        .map((row) => {
          const node = changeRowNodesRef.current[row.key]
          if (!node) return null
          const rect = node.getBoundingClientRect()
          return { path: row.key, top: rect.top, bottom: rect.bottom }
        })
        .filter((row): row is { path: string; top: number; bottom: number } => Boolean(row))
      const keys = fileExplorerSelectionFromVerticalRange(bounds, changeDragRef.current.startY, clientY)
      changeDragCompletedRef.current = keys.length > 0
      setSelectedChangeKeys(new Set(keys))
    }
    const handleMouseMove = (event: MouseEvent) => updateDragSelection(event.clientY)
    const handleMouseUp = () => {
      if (!changeDragRef.current) return
      changeDragRef.current = null
      // Let the click that closes the drag see the suppression flag, then clear it.
      window.setTimeout(() => {
        changeDragCompletedRef.current = false
      }, 0)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const beginChangeMarquee = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof Element && event.target.closest('[data-git-change-row="true"]')) return
    event.preventDefault()
    changeDragRef.current = { startY: event.clientY }
    changeDragCompletedRef.current = false
    selectionAnchorKeyRef.current = null
    setSelectedChangeKeys(new Set())
  }

  // Returns true when the click was consumed as a selection gesture (marquee
  // suppression, shift-range, or meta-toggle) and must not also open the diff.
  const handleChangeRowSelect = (
    entry: GitStatusEntry,
    scope: 'staged' | 'unstaged',
    event: React.MouseEvent
  ): boolean => {
    if (changeDragCompletedRef.current) return true
    const key = changeSelectionKey(scope, entry.path)
    if (event.shiftKey && selectionAnchorKeyRef.current) {
      const keys = fileExplorerSelectionRange(
        selectableRowsRef.current.map((row) => row.key),
        selectionAnchorKeyRef.current,
        key
      )
      if (keys.length) setSelectedChangeKeys(new Set(keys))
      return true
    }
    if (event.metaKey || event.ctrlKey) {
      selectionAnchorKeyRef.current = key
      setSelectedChangeKeys((current) => {
        const next = new Set(current)
        if (next.has(key) && next.size > 1) next.delete(key)
        else next.add(key)
        return next
      })
      return true
    }
    selectionAnchorKeyRef.current = key
    setSelectedChangeKeys(new Set([key]))
    return false
  }

  const registerChangeRowNode = (key: string, node: HTMLElement | null) => {
    if (node) changeRowNodesRef.current[key] = node
    else delete changeRowNodesRef.current[key]
  }

  // Primary action (stage on unstaged rows, unstage on staged rows). Batches
  // across the selection only when the clicked row is part of a multi-selection.
  const handleChangeRowPrimary = (entry: GitStatusEntry, scope: 'staged' | 'unstaged') => {
    const key = changeSelectionKey(scope, entry.path)
    const batching = selectedChangeKeys.has(key) && selectedChangeKeys.size > 1
    const paths = batching
      ? selectableRows.filter((row) => row.scope === scope && selectedChangeKeys.has(row.key)).map((row) => row.entry.path)
      : [entry.path]
    if (paths.length === 0) return
    const result = scope === 'staged' ? unstagePaths(paths) : stagePaths(paths)
    if (batching) setSelectedChangeKeys(new Set())
    return result
  }

  const handleChangeRowRevert = async (entry: GitStatusEntry, scope: 'staged' | 'unstaged') => {
    const key = changeSelectionKey(scope, entry.path)
    const batching = selectedChangeKeys.has(key) && selectedChangeKeys.size > 1
    const entries = batching
      ? selectableRows.filter((row) => selectedChangeKeys.has(row.key)).map((row) => row.entry)
      : [entry]
    const result = await revertEntries(entries)
    if (batching && result !== null) setSelectedChangeKeys(new Set())
    return result
  }

  const handleCommit = async () => {
    if (!repoRoot) return
    const result = await runAction(
      'Committing',
      () => window.api.commitGitChanges(repoRoot, commitMessage),
      'Committed changes.'
    )
    if (result?.ok) {
      if (commitDraftTimerRef.current) {
        window.clearTimeout(commitDraftTimerRef.current)
        commitDraftTimerRef.current = null
      }
      setCommitMessage('')
      clearGitCommitDraft(workspaceId, activeScopeId)
    }
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
    await runAction(
      'Pulling',
      () => window.api.pullGitBranchWithStash(repoRoot),
      'Pulled branch and reapplied local changes.'
    )
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

  const handleMergeTarget = async (target: GitMergeTarget) => {
    if (!repoRoot) return
    if (typeof window.api.mergeGitRef !== 'function') {
      setMessage({ tone: 'error', text: 'Restart the app to enable Git merge.' })
      return
    }
    const currentBranch = branches?.current
    if (!currentBranch) {
      setMessage({ tone: 'error', text: 'Check out a branch before merging.' })
      return
    }

    const subject = target.kind === 'commit'
      ? (
        <>
          commit <span className="font-mono">{target.commit.shortHash}</span>
        </>
      )
      : (
        <>
          <span className="font-mono">{target.label}</span>
        </>
      )
    const confirmed = await dialog.confirm({
      title: `Merge into ${currentBranch}?`,
      body: (
        <>
          This merges {subject} into <span className="font-mono">{currentBranch}</span> in {activeScopeLabel}. If Git
          reports conflicts, Multicode will leave the merge state in the working tree for you to resolve.
          <div className="mt-2 font-mono text-[12px] text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
        </>
      ),
      confirmLabel: 'Merge',
    })
    if (!confirmed) return

    await runAction(
      'Merging',
      () => window.api.mergeGitRef(repoRoot, target.ref),
      target.kind === 'commit'
        ? `Merged ${target.commit.shortHash} into ${currentBranch}.`
        : `Merged ${target.label} into ${currentBranch}.`
    )
  }

  // Operations added after an app update need a preload restart; surface that
  // instead of a dead menu item (same idiom as merge/pull above).
  const requireApi = (api: unknown, label: string): boolean => {
    if (typeof api === 'function') return true
    setMessage({ tone: 'error', text: `Restart the app to enable ${label}.` })
    return false
  }

  const handleRebaseTarget = async (target: GitMergeTarget) => {
    if (!repoRoot || !requireApi(window.api.rebaseGitBranch, 'Git rebase')) return
    const currentBranch = branches?.current
    if (!currentBranch) {
      setMessage({ tone: 'error', text: 'Check out a branch before rebasing.' })
      return
    }

    const subjectLabel = target.kind === 'commit' ? `commit ${target.commit.shortHash}` : target.label
    const confirmed = await dialog.confirm({
      title: `Rebase ${currentBranch} onto ${subjectLabel}?`,
      body: (
        <>
          This replays the commits of <span className="font-mono">{currentBranch}</span> on top of{' '}
          <span className="font-mono">{subjectLabel}</span> in {activeScopeLabel}, rewriting their hashes. If Git
          reports conflicts, Multicode will pause the rebase for you to resolve and continue.
          <div className="mt-2 font-mono text-[12px] text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
        </>
      ),
      confirmLabel: 'Rebase',
    })
    if (!confirmed) return

    await runAction(
      'Rebasing',
      () => window.api.rebaseGitBranch(repoRoot, target.ref),
      `Rebased ${currentBranch} onto ${subjectLabel}.`
    )
  }

  const handleCherryPick = async (commit: GitGraphCommit) => {
    if (!repoRoot || !requireApi(window.api.cherryPickGitCommit, 'Git cherry-pick')) return
    const currentBranch = branches?.current
    if (!currentBranch) {
      setMessage({ tone: 'error', text: 'Check out a branch before cherry-picking.' })
      return
    }

    const confirmed = await dialog.confirm({
      title: `Cherry-pick ${commit.shortHash} into ${currentBranch}?`,
      body: (
        <>
          This applies “{commit.subject}” onto <span className="font-mono">{currentBranch}</span> as a new commit. If
          Git reports conflicts, Multicode will pause the cherry-pick for you to resolve and continue.
        </>
      ),
      confirmLabel: 'Cherry-pick',
    })
    if (!confirmed) return

    await runAction(
      'Cherry-picking',
      () => window.api.cherryPickGitCommit(repoRoot, commit.hash),
      `Cherry-picked ${commit.shortHash} into ${currentBranch}.`
    )
  }

  const handleRevertCommit = async (commit: GitGraphCommit) => {
    if (!repoRoot || !requireApi(window.api.revertGitCommit, 'Git revert')) return
    const confirmed = await dialog.confirm({
      title: `Revert ${commit.shortHash}?`,
      body: (
        <>
          This creates a new commit that undoes “{commit.subject}”. History is kept; nothing is rewritten.
        </>
      ),
      confirmLabel: 'Revert commit',
    })
    if (!confirmed) return

    await runAction(
      'Reverting commit',
      () => window.api.revertGitCommit(repoRoot, commit.hash),
      `Reverted ${commit.shortHash}.`
    )
  }

  const handleResetToCommit = async (commit: GitGraphCommit, mode: GitResetMode) => {
    if (!repoRoot || !requireApi(window.api.resetGitBranchToCommit, 'Git reset')) return
    const currentBranch = branches?.current
    if (!currentBranch) {
      setMessage({ tone: 'error', text: 'Check out a branch before resetting.' })
      return
    }

    const consequence =
      mode === 'hard'
        ? 'Commits after it are dropped from this branch and every uncommitted change is discarded. The action cannot be undone from Multicode.'
        : mode === 'soft'
          ? 'Commits after it stay in the working tree as staged changes.'
          : 'Commits after it stay in the working tree as unstaged changes.'
    const confirmed = await dialog.confirm({
      title: `Reset ${currentBranch} to ${commit.shortHash}?`,
      body: (
        <>
          This moves <span className="font-mono">{currentBranch}</span> back to “{commit.subject}” ({mode} reset).{' '}
          {consequence}
          <div className="mt-2 font-mono text-[12px] text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
        </>
      ),
      confirmLabel: mode === 'hard' ? 'Hard reset' : 'Reset',
      tone: mode === 'hard' ? 'danger' : 'default',
    })
    if (!confirmed) return

    await runAction(
      'Resetting branch',
      () => window.api.resetGitBranchToCommit(repoRoot, commit.hash, mode),
      `Reset ${currentBranch} to ${commit.shortHash} (${mode}).`
    )
  }

  const handleDeleteBranch = async (branchName: string) => {
    if (!repoRoot || !requireApi(window.api.deleteGitBranch, 'Git branch deletion')) return
    const confirmed = await dialog.confirm({
      title: `Delete branch ${branchName}?`,
      body: (
        <>
          This deletes the local branch <span className="font-mono">{branchName}</span>. Its commits stay reachable
          from other refs; a branch with unmerged commits is refused unless you force-delete it.
        </>
      ),
      confirmLabel: 'Delete branch',
      tone: 'danger',
    })
    if (!confirmed) return

    const result = await runAction(
      'Deleting branch',
      () => window.api.deleteGitBranch(repoRoot, branchName),
      `Deleted ${branchName}.`
    )
    if (!result || result.ok) return

    // Git refuses branches that aren't fully merged; escalate explicitly rather
    // than defaulting to -D (matches the usual editor delete-branch flow). Matching
    // git's English text is safe: the main process pins LC_ALL=C on every git
    // invocation (git-utils.ts).
    if (!/not fully merged/i.test(`${result.message ?? ''}\n${result.stderr}`)) return
    const forceConfirmed = await dialog.confirm({
      title: `${branchName} is not fully merged`,
      body: (
        <>
          Branch <span className="font-mono">{branchName}</span> has commits that are not merged anywhere else.
          Force-deleting it makes those commits unreachable.
        </>
      ),
      confirmLabel: 'Force delete',
      tone: 'danger',
    })
    if (!forceConfirmed) return

    await runAction(
      'Force-deleting branch',
      () => window.api.deleteGitBranch(repoRoot, branchName, true),
      `Deleted ${branchName}.`
    )
  }

  const handleRenameBranch = async (branchName: string) => {
    if (!repoRoot || !requireApi(window.api.renameGitBranch, 'Git branch renaming')) return
    const newName = await dialog.prompt({
      title: `Rename ${branchName}`,
      inputLabel: 'New branch name',
      initialValue: branchName,
      required: true,
      confirmLabel: 'Rename',
    })
    if (!newName || newName.trim() === branchName) return

    await runAction(
      'Renaming branch',
      () => window.api.renameGitBranch(repoRoot, branchName, newName),
      `Renamed ${branchName} to ${newName.trim()}.`
    )
  }

  const operationInProgress = status?.operation ?? null

  const handleContinueOperation = async () => {
    if (!repoRoot || !operationInProgress || !requireApi(window.api.continueGitOperation, 'Git continue')) return
    await runAction(
      'Continuing',
      () => window.api.continueGitOperation(repoRoot, operationInProgress),
      `Continued the ${operationInProgress.replace('-', ' ')}.`
    )
  }

  const handleAbortOperation = async () => {
    if (!repoRoot || !operationInProgress || !requireApi(window.api.abortGitOperation, 'Git abort')) return
    const label = operationInProgress.replace('-', ' ')
    const confirmed = await dialog.confirm({
      title: `Abort the ${label}?`,
      body: <>This rolls the working tree back to the state before the {label} started.</>,
      confirmLabel: 'Abort',
      tone: 'danger',
    })
    if (!confirmed) return
    await runAction(
      'Aborting',
      () => window.api.abortGitOperation(repoRoot, operationInProgress),
      `Aborted the ${label}.`
    )
  }

  const handleStashPush = async () => {
    if (!repoRoot || !requireApi(window.api.pushGitStash, 'Git stash')) return
    const stashMessage = await dialog.prompt({
      title: 'Stash changes',
      body: <>Sets every local change aside (staged, unstaged, and untracked files) and cleans the working tree.</>,
      inputLabel: 'Message (optional)',
      placeholder: 'What is in this stash?',
      confirmLabel: 'Stash',
    })
    if (stashMessage === null) return

    await runAction(
      'Stashing changes',
      () => window.api.pushGitStash(repoRoot, stashMessage, true),
      'Stashed changes.'
    )
  }

  const handleStashApply = async (entry: GitStashEntry, pop: boolean) => {
    if (!repoRoot || !requireApi(window.api.applyGitStash, 'Git stash apply')) return
    await runAction(
      pop ? 'Popping stash' : 'Applying stash',
      () => window.api.applyGitStash(repoRoot, entry.index, entry.hash, pop),
      pop ? `Popped ${entry.ref}.` : `Applied ${entry.ref}.`
    )
  }

  const handleStashDrop = async (entry: GitStashEntry) => {
    if (!repoRoot || !requireApi(window.api.dropGitStash, 'Git stash drop')) return
    const confirmed = await dialog.confirm({
      title: `Drop ${entry.ref}?`,
      body: (
        <>
          This deletes the stash entry “{entry.message}”. The action cannot be undone from Multicode.
        </>
      ),
      confirmLabel: 'Drop stash',
      tone: 'danger',
    })
    if (!confirmed) return
    await runAction(
      'Dropping stash',
      () => window.api.dropGitStash(repoRoot, entry.index, entry.hash),
      `Dropped ${entry.ref}.`
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
    merge: (target) => void handleMergeTarget(target),
    rebaseOnto: (target) => void handleRebaseTarget(target),
    cherryPick: (commit) => void handleCherryPick(commit),
    revertCommit: (commit) => void handleRevertCommit(commit),
    resetToCommit: (commit, mode) => void handleResetToCommit(commit, mode),
    deleteBranch: (branchName) => void handleDeleteBranch(branchName),
    renameBranch: (branchName) => void handleRenameBranch(branchName),
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

  // Activating a changed row opens the dedicated diff viewer window (the IDE
  // idiom): old content left, new content right, arrow-key hunk navigation that
  // flows across files. The scope picks which diff to show first — a staged row
  // shows HEAD↔index, an unstaged row index↔worktree. Tab-opening stays
  // available via the row's "Open file in editor" context-menu entry.
  const handleOpenFile = async (entry: GitStatusEntry, scope: 'staged' | 'unstaged') => {
    if (!repoRoot) return
    await openDiffWindow({ repoRoot, focusPath: entry.path, scope })
  }

  const handleOpenFileInEditor = async (entry: GitStatusEntry) => {
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

    openFileSurface({ workspaceId, path: entry.path, name, content })
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
       * Contextual header on the shared PanelHeader so Git reads with the same
       * identity row as every other panel. Title is "Git"; the subtitle carries
       * sync state the usual editor way — scope health when the checkout
       * is unhealthy, otherwise the ahead/behind summary. Pull/Push stay live
       * affordances (not dead text) in the header actions; the captioned Branch /
       * Worktree dropdowns follow in the secondary strip (GitHub Desktop) so each
       * reads without guessing.
       */}
      <PanelHeader
        title="Git"
        subtitle={scopeHealth?.label ?? syncSummary ?? undefined}
        overflow={
          <>
            {behind > 0 ? (
              <Tooltip content={`Pull ${behind} commit${behind === 1 ? '' : 's'}${upstreamLabel ? ` from ${upstreamLabel}` : ''}`} placement="bottom">
                <button
                  type="button"
                  onClick={() => void handlePull()}
                  disabled={Boolean(busy)}
                  className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-semibold tabular-nums text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] disabled:opacity-35"
                >
                  <SyncArrowIcon direction="down" />
                  Pull {behind}
                </button>
              </Tooltip>
            ) : null}
            {ahead > 0 ? (
              <Tooltip content={`Push ${ahead} commit${ahead === 1 ? '' : 's'}${upstreamLabel ? ` to ${upstreamLabel}` : ''}`} placement="bottom">
                <button
                  type="button"
                  onClick={() => void handlePush()}
                  disabled={Boolean(busy)}
                  className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-semibold tabular-nums text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] disabled:opacity-35"
                >
                  <SyncArrowIcon direction="up" />
                  Push {ahead}
                </button>
              </Tooltip>
            ) : null}
            <Tooltip content="Fetch remotes and refresh Git status" placement="bottom">
              <IconButton
                aria-label="Fetch remotes and refresh Git status"
                onClick={() => void handleFetch()}
                disabled={Boolean(busy)}
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </>
        }
      />
      <div className="space-y-1 border-b border-[color:var(--border-subtle)] px-3 pb-2 pt-2">
          {/*
           * A sprint spanning projects works one project at a time, in that
           * project's own checkout — so the project comes first: it decides which
           * branches, worktrees, changes, and commits the rest of the panel is
           * even about. A sprint in a single project has nothing to choose
           * between, so the row never appears and the panel is unchanged.
           */}
          {workspaceWorktrees.length > 1 ? (
            <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2" title={activeRepoRoot ?? undefined}>
              <span className="text-[11px] text-[color:var(--text-subtle)]">Project</span>
              <Select<string>
                ariaLabel="Active project"
                items={workspaceWorktrees.map((entry) => ({
                  value: entry.repoId ?? entry.gitRoot,
                  label: basename(entry.repoRoot ?? entry.gitRoot),
                }))}
                value={activeRepoEntry?.repoId ?? activeRepoEntry?.gitRoot ?? ''}
                onChange={(next) => setActiveRepoId(next)}
                disabled={Boolean(busy)}
                className="w-full"
                triggerMinWidthClassName="min-w-0"
              />
            </div>
          ) : null}
          <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2">
            <span className="text-[11px] text-[color:var(--text-subtle)]">Branch</span>
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
              triggerMinWidthClassName="min-w-0"
            />
          </div>
          {/*
           * The worktree picker chooses which checkout the Changes / Log /
           * Terminal tabs operate on, so it only earns space when extra worktrees
           * exist and the user isn't already on the Worktrees tab (which manages
           * them all). "Review changes" rides alongside it and appears only on a
           * worktree scope, where comparing the branch against its base is the
           * point — never as a permanently greyed-out button.
           */}
          {worktreeCount > 0 && activeView !== 'worktrees' ? (
            <div
              className={`grid ${activeScope?.kind === 'worktree' ? 'grid-cols-[4rem_minmax(0,1fr)_auto]' : 'grid-cols-[4rem_minmax(0,1fr)]'} items-center gap-2`}
              title={activeScopePath}
            >
              <span className="text-[11px] text-[color:var(--text-subtle)]">Worktree</span>
              <Select<string>
                ariaLabel="Active worktree"
                items={scopeOptions.map((scope) => ({
                  value: scope.id,
                  label: scope.label,
                  disabled: scope.missing || scope.locked || scope.prunable,
                }))}
                value={activeScope?.id ?? 'main'}
                onChange={(next) => {
                  userSelectedScopeRef.current = true
                  setActiveScopeId(next)
                }}
                disabled={Boolean(busy)}
                className="w-full"
                triggerMinWidthClassName="min-w-0"
              />
              {activeScope?.kind === 'worktree' ? (
                <Tooltip content={`Review this branch's changes against ${reviewDiffTarget.baseRef}`} placement="bottom">
                  <button
                    type="button"
                    onClick={() => void handleReviewDiff()}
                    disabled={Boolean(busy) || !repoRoot}
                    className="h-6 rounded-md px-2 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] disabled:opacity-35"
                  >
                    Review changes
                  </button>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </div>

      {operationInProgress ? (
        <div className="shrink-0 border-b border-[color:var(--border-subtle)] px-3 py-2">
          <InlineNotice
            tone="warn"
            action={
              <span className="flex shrink-0 items-center gap-1">
                <GhostButton onClick={() => void handleContinueOperation()} disabled={Boolean(busy)}>
                  Continue
                </GhostButton>
                <GhostButton onClick={() => void handleAbortOperation()} disabled={Boolean(busy)}>
                  Abort
                </GhostButton>
              </span>
            }
          >
            <span className="font-medium">{OPERATION_LABELS[operationInProgress]} in progress</span>
            {' — '}
            <span>resolve any conflicts, then continue. Abort rolls the working tree back.</span>
          </InlineNotice>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {/*
         * Scrolls horizontally: the strip already overflowed a narrow panel at
         * four tabs (Terminal clipped past the right edge), and Stashes made it
         * five. Tabs stay shrink-0 so they scroll rather than squeeze.
         */}
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3" role="tablist" aria-label="Git panel views">
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
            active={activeView === 'stashes'}
            label="Stashes"
            count={stashes.length}
            onClick={() => setActiveView('stashes')}
          />
          <GitPanelTab
            active={activeView === 'terminal'}
            label="Terminal"
            onClick={() => setActiveView('terminal')}
          />
        </div>

        {activeView === 'changes' ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" onMouseDown={beginChangeMarquee}>
              {allEntries.length === 0 ? (
                <div className="py-2 text-[12px] text-[color:var(--text-subtle)]">Working tree clean</div>
              ) : (
                <>
                  <ConflictGroup
                    entries={conflictEntries}
                    busy={busy}
                    onOpenFile={handleOpenFileInEditor}
                    onResolve={handleResolveConflict}
                  />
                  {groups.map((group) => (
                    <ChangeGroup
                      key={group.title}
                      group={group}
                      busy={busy}
                      onOpenFile={handleOpenFile}
                      onOpenFileInEditor={handleOpenFileInEditor}
                      selectedKeys={selectedChangeKeys}
                      onRowSelect={handleChangeRowSelect}
                      onRowPrimaryAction={handleChangeRowPrimary}
                      onRowRevert={handleChangeRowRevert}
                      registerRowNode={registerChangeRowNode}
                    />
                  ))}
                </>
              )}
            </div>

            <CommitComposer
              busy={busy}
              commitMessage={commitMessage}
              readyToCommit={readyToCommit}
              stagedCount={stagedEntries.length}
              onCommit={handleCommit}
              onCommitMessageChange={handleCommitMessageChange}
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
        ) : activeView === 'stashes' ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <StashList
              stashes={stashes}
              busy={busy}
              onApply={(entry, pop) => void handleStashApply(entry, pop)}
              onDrop={(entry) => void handleStashDrop(entry)}
            />
          </div>
        ) : (
          <GitTerminalView
            key={`${workspaceId}:${repoRoot}`}
            workspaceId={workspaceId}
            repoRoot={repoRoot}
            terminalId={`git-${workspaceId}-${terminalIdPart(activeScope?.id ?? repoRoot)}`}
          />
        )}
      </div>

      {/*
       * Panel-level action feedback, mounted on every tab. It used to live
       * inside CommitComposer, so a merge/rebase refused from the Log view
       * failed silently — the operation ran, the message went to state nobody
       * rendered ("my merge did nothing").
       */}
      {message ? (
        <div className="shrink-0 px-3 pb-3 pt-2">
          <div
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={`max-h-24 overflow-y-auto rounded-md px-2.5 py-2 text-[11px] [overflow-wrap:anywhere] ${
              message.tone === 'error'
                ? 'border border-[color:var(--tone-error)] bg-[color:var(--tone-error-soft)] text-[color:var(--tone-error)]'
                : message.tone === 'success'
                  ? 'bg-transparent px-0 py-0 text-[color:var(--text-muted)]'
                  : 'bg-[color:var(--bg-hover)] text-[color:var(--text-muted)]'
            }`}
          >
            {message.text}
          </div>
        </div>
      ) : null}
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
          <Skeleton className="h-3 w-24 rounded bg-[color:var(--skeleton-shimmer-high)]" />
          <Skeleton className="h-5 w-5 shrink-0 rounded bg-[color:var(--skeleton-shimmer-high)]" />
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 px-3 pb-2">
          <Skeleton className="h-3 w-10 rounded bg-[color:var(--skeleton-shimmer-high)]" />
          <Skeleton className="h-7 rounded-md bg-[color:var(--skeleton-shimmer-high)]" />
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
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] ${
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
                  <span className="min-w-0 shrink truncate text-[color:var(--text-muted)] [direction:rtl]">
                    {pathParts.directory}
                  </span>
                  <span className="shrink-0 text-[color:var(--text-muted)]">/</span>
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

// Parked work lives here, not in a hidden `git stash list`: apply/pop/drop are
// one click, which is also the remedy the dirty-tree merge/rebase guards point
// at. Body of the Stashes tab, which supplies the heading and the count — hence
// no section header here, and an empty state rather than rendering nothing.
function StashList({
  stashes,
  busy,
  onApply,
  onDrop,
}: {
  stashes: GitStashEntry[]
  busy: string | null
  onApply: (entry: GitStashEntry, pop: boolean) => void
  onDrop: (entry: GitStashEntry) => void
}) {
  if (stashes.length === 0) {
    return (
      <div className="py-2 text-[12px] text-[color:var(--text-subtle)]">
        No stashes — park the working tree with Stash on the Changes tab.
      </div>
    )
  }

  return (
    <section>
      <div className="space-y-1">
        {/*
         * Each row gives the message a full-width line of its own, with meta and
         * actions sharing the line below. Actions alongside the message starved it
         * down to a few characters ("spi...") at the panel's default width, which
         * defeats the point of a tab you open to tell stashes apart.
         */}
        {stashes.map((entry) => (
          <div key={entry.ref} className="group/row flex flex-col py-1">
            <span className="min-w-0 truncate text-[12px] text-[color:var(--text-default)]" title={entry.message}>
              {entry.message || 'Stashed changes'}
            </span>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="flex min-w-[7rem] flex-1 items-center gap-1.5 overflow-hidden text-[10px] text-[color:var(--text-disabled)]">
                <span className="shrink-0 font-mono text-[color:var(--text-muted)]">{entry.ref}</span>
                {entry.branch ? (
                  <>
                    <span aria-hidden="true" className="shrink-0">·</span>
                    <span className="min-w-0 truncate">on {entry.branch}</span>
                  </>
                ) : null}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1 opacity-70 group-hover/row:opacity-100">
                <Tooltip content={`Reapply ${entry.ref} and drop it`}>
                  <button
                    type="button"
                    onClick={() => onApply(entry, true)}
                    disabled={Boolean(busy)}
                    className="h-6 rounded-md px-2 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:opacity-30"
                    aria-label={`Pop ${entry.ref}`}
                  >
                    Pop
                  </button>
                </Tooltip>
                <Tooltip content={`Reapply ${entry.ref} and keep it`}>
                  <button
                    type="button"
                    onClick={() => onApply(entry, false)}
                    disabled={Boolean(busy)}
                    className="h-6 rounded-md px-2 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:opacity-30"
                    aria-label={`Apply ${entry.ref}`}
                  >
                    Apply
                  </button>
                </Tooltip>
                <Tooltip content={`Delete ${entry.ref}`}>
                  <button
                    type="button"
                    onClick={() => onDrop(entry)}
                    disabled={Boolean(busy)}
                    className="h-6 rounded-md px-2 text-[11px] font-semibold text-[color:var(--tone-error)] transition-colors hover:bg-[color:var(--tone-error-soft)] disabled:opacity-30"
                    aria-label={`Drop ${entry.ref}`}
                  >
                    Drop
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

async function showChangeRowContextMenu(
  event: React.MouseEvent,
  entry: GitStatusEntry,
  scope: 'staged' | 'unstaged',
  onOpenFile: (entry: GitStatusEntry, scope: 'staged' | 'unstaged') => Promise<void>,
  onOpenFileInEditor: (entry: GitStatusEntry) => Promise<void>
): Promise<void> {
  event.preventDefault()
  event.stopPropagation()
  if (typeof window.api.showContextMenu !== 'function') return
  const command = await window.api.showContextMenu([
    { id: 'view-diff', label: 'View Git Diff' },
    { id: 'open-in-editor', label: 'Open File in Editor' },
  ])
  if (command === 'view-diff') return void onOpenFile(entry, scope)
  if (command === 'open-in-editor') return void onOpenFileInEditor(entry)
}

function ChangeGroup({
  group,
  busy,
  onOpenFile,
  onOpenFileInEditor,
  selectedKeys,
  onRowSelect,
  onRowPrimaryAction,
  onRowRevert,
  registerRowNode,
}: {
  group: GitChangeGroup
  busy: string | null
  onOpenFile: (entry: GitStatusEntry, scope: 'staged' | 'unstaged') => Promise<void>
  onOpenFileInEditor: (entry: GitStatusEntry) => Promise<void>
  selectedKeys: Set<string>
  onRowSelect: (entry: GitStatusEntry, scope: 'staged' | 'unstaged', event: React.MouseEvent) => boolean
  onRowPrimaryAction: (entry: GitStatusEntry, scope: 'staged' | 'unstaged') => void
  onRowRevert: (entry: GitStatusEntry, scope: 'staged' | 'unstaged') => void
  registerRowNode: (key: string, node: HTMLElement | null) => void
}) {
  const selectedInGroup = group.entries.reduce(
    (count, entry) => (selectedKeys.has(changeSelectionKey(group.scope, entry.path)) ? count + 1 : count),
    0
  )
  const selectedTotal = selectedKeys.size
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
                      <span className="min-w-0 shrink truncate text-[color:var(--text-muted)] [direction:rtl]">
                        {pathParts.directory}
                      </span>
                      <span className="shrink-0 text-[color:var(--text-muted)]">/</span>
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
              const rowKey = changeSelectionKey(group.scope, entry.path)
              const rowSelected = selectedKeys.has(rowKey)
              // A batch fires when the clicked row is part of a multi-selection.
              // Primary batches within this scope; revert batches across scopes.
              const primaryBatch = rowSelected && selectedInGroup > 1
              const revertBatch = rowSelected && selectedTotal > 1
              const primaryTitle = primaryBatch ? `${group.actionTitle.split(' ')[0]} ${selectedInGroup} selected files` : group.actionTitle
              const revertTitle = revertBatch ? `Revert ${selectedTotal} selected files` : group.secondaryAction?.title
              // Keep the actions hidden until the row is hovered, focused, or part
              // of the current selection — so a resting list stays calm, but every
              // selected row still advertises the batch it will act on.
              // Base button classes already carry `focus:opacity-100`, so a
              // keyboard-focused action stays revealed in every state.
              const actionVisibility = rowSelected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
              return (
                <div
                  key={`${group.title}:${entry.path}`}
                  ref={(node) => registerRowNode(rowKey, node)}
                  data-git-change-row="true"
                  className="group/row flex items-center gap-1"
                  onContextMenu={(event) =>
                    void showChangeRowContextMenu(event, entry, group.scope, onOpenFile, onOpenFileInEditor)
                  }
                >
                  <div className="min-w-0 flex-1">
                    <InboxRow
                      hideDot
                      title={title}
                      trailing={trailing}
                      selected={rowSelected}
                      onSelect={(event) => {
                        // Modifier/marquee clicks are consumed for selection; a
                        // plain click selects the single row and opens its diff.
                        if (onRowSelect(entry, group.scope, event)) return
                        void onOpenFile(entry, group.scope)
                      }}
                      ariaLabel={statusWord ? `Open ${entry.relativePath}, ${statusWord}` : `Open ${entry.relativePath}`}
                    />
                  </div>
                  <Tooltip content={primaryTitle}>
                    <button
                      type="button"
                      onClick={() => void onRowPrimaryAction(entry, group.scope)}
                      disabled={Boolean(busy)}
                      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] disabled:opacity-30 ${actionVisibility}`}
                      aria-label={`${primaryTitle}: ${entry.relativePath}`}
                    >
                      <GitActionIcon kind={group.actionIcon} />
                    </button>
                  </Tooltip>
                  {group.secondaryAction ? (
                    <Tooltip content={revertTitle ?? group.secondaryAction.title}>
                      <button
                        type="button"
                        onClick={() => void onRowRevert(entry, group.scope)}
                        disabled={Boolean(busy)}
                        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[color:var(--tone-error)] transition-colors hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)] focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[color:var(--tone-error)] disabled:opacity-30 ${actionVisibility}`}
                        aria-label={`${revertTitle ?? group.secondaryAction.title}: ${entry.relativePath}`}
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
        className="h-16 w-full resize-none rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-2.5 py-2 text-[12px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] transition-colors focus:border-[color:var(--border-strong)]"
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
    </section>
  )
}
