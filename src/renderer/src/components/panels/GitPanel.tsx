import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStatus } from '../../hooks/useGitStatus'
import { getGitScopeStatusAppearance, getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { focusOrAddGitConflictTab, focusOrAddTerminalTab } from '../../utils/modelRegistry'
import { isImageFile } from '../../utils/files'
import { openFileSurface } from '../../utils/openFileSurface'
import { openGitDiff } from '../../utils/openGitDiff'
import { openDiffWindow } from '../auxWindows/openDiffWindow'
import { basename, samePath, trimPath } from '../../utils/paths'
import {
  fileExplorerSelectionFromVerticalRange,
  fileExplorerSelectionRange,
} from '../../utils/fileExplorerSelection'
import { findHealthyWorktreeScope, resolveWorkspaceWorktrees, workspaceProjectRoot } from '../../utils/workspaceWorktree'
import WorktreeManager from '../worktree/WorktreeManager'
import PlainTerminalPanel from './PlainTerminalPanel'
import { EmptyState, FOCUS_RING_CLASS, FileTypeGlyph, GhostButton, IconButton, InboxRow, InlineNotice, PrimaryButton, RefreshIcon, Select, Skeleton, StashGlyph, TabPanel, Tabs, TabsScroller, Textarea, Tooltip, TruncatedText, type LifecycleState, type TabItem } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { buildChangeRowMenu } from './git/changeRowMenu'
import { GitChangesList } from './git/GitChangesList'
import { GitChangesToolbar, type ShowDiffPlacement } from './git/GitChangesToolbar'
import {
  buildGitChangeGroups,
  commitCounts,
  formatCommitCounts,
  groupToggleAction,
  nextCheckIntent,
  nextCursorPath,
  splitGitPath,
  visibleChangeRows,
  type GitChangeGroup,
  type GitChangeRow,
} from './git/gitChangesModel'
import { GitGraphView, type GitCommitActions, type GitGraphState, type GitMergeTarget } from './GitGraphView'
import type { GitPanelView } from '../../types/workspace'

type GitPanelMessage = {
  tone: 'neutral' | 'error' | 'success'
  text: string
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

const GIT_PANEL_AUTO_REFRESH_MS = 10_000
const GIT_GRAPH_PAGE_SIZE = 200
const STANDARD_BASE_BRANCHES = ['main', 'master', 'develop', 'trunk']

// Incoming (down = pull) / outgoing (up = push) arrow, matching the IDE sync
// idiom. The button it sits in is glyph + count, no word (owner 2026-09-05,
// each control is a mark with a tooltip) — so the arrow is
// the control's whole face and draws at the strip's 16px step, with the verb,
// the count and the remote riding the tooltip and the accessible name.
function SyncArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
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

// The five view glyphs for the panel's icon-only Tabs strip. Drawn on the same
// 16px grid at the same 1.4 stroke as SyncArrowIcon above, so the strip and the
// sync affordances beside it read as one set of marks rather than two families
// sharing a band. Each answers "which view is this" and nothing else; the name
// and the count ride the tooltip.
//
// Three of the five were redrawn on 2026-09-05 (owner) to the shapes IDEs
// has taught a decade of developers to read — the first set (a plus-and-slash
// for Changes, a wiring diagram for Worktrees, two bullet lines for Log) had to
// be learned from the tooltip. Changes uses a commit node on a
// line; Worktrees is a folder holding that node — a checkout in its own
// directory; Log is the history clock. Stashes (the drawer) and Terminal were
// already legible and stay. Mirrored framework-neutral in design-system/glyphs
// as commit.svg, worktree.svg and history.svg.
function ChangesViewGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.75 8h3.65M10.6 8h3.65" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function WorktreesViewGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <path
        d="M1.75 4.75c0-.83.67-1.5 1.5-1.5h3.1l1.5 1.5h5.4c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="9.6" r="1.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.25 9.6h2.5M9.25 9.6h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function LogViewGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <path d="M2.75 8a5.25 5.25 0 1 0 1.55-3.72" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2.6 2.5v2.95h2.95" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 5.1V8.2l2.2 1.35" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// `StashesViewGlyph` used to be drawn here, with no asset behind it. Stashes is
// the one view mark that is also an ACTION — the Commit toolbar's "Stash
// changes…" is the same concept — so the drawer moved to the kit as
// `StashGlyph` (design-system/glyphs/stash.svg) and both hosts import it.

function TerminalViewGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.9 6.5 6.9 8.5 4.9 10.5M8.6 10.6h2.6"
        stroke="currentColor"
        strokeWidth="1.4"
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
  const allEntries = useMemo(() => sortedEntries(statusEntries), [statusEntries])
  // The checklist. `buildGitChangeGroups` returns the conflicts group too; the
  // panel renders those through `ConflictGroup` above the list, because a
  // conflicted file is resolved rather than ticked. Everything else is the
  // checklist — one "Changes" group today, one per changelist once T6 lands,
  // and nothing below this line knows which.
  const changeGroups = useMemo(() => buildGitChangeGroups(statusEntries), [statusEntries])
  const checklistGroups = useMemo(
    () => changeGroups.filter((group) => group.checked !== null),
    [changeGroups]
  )
  const changeCounts = useMemo(() => commitCounts(statusEntries), [statusEntries])
  const branchOptions = branches?.branches ?? []
  const worktreeCount = scopeOptions.filter((scope) => scope.kind === 'worktree').length
  const totalCommitCount = graph.status === 'ready' ? graph.snapshot.totalCount : 0
  const detachedReturnBranch = useMemo(() => {
    // In detached HEAD, `git branch` yields an empty-named pseudo-entry; ignore it.
    const named = branchOptions.filter((branch) => branch.name.trim().length > 0)
    const standard = named.find((branch) => STANDARD_BASE_BRANCHES.includes(branch.name))
    return standard?.name ?? named[0]?.name ?? null
  }, [branchOptions])
  // "Checked" is exactly "in the index", and commit is index-only — so the
  // button is live when the line above it reads more than zero.
  const readyToCommit = changeCounts.checked > 0 && Boolean(commitMessage.trim())
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
  // Discard. Takes rows rather than status entries because the checklist is what
  // asks for it now, and a row already carries both spellings of the path.
  const revertEntries = async (entries: Array<{ path: string; relativePath: string }>) => {
    const seen = new Set<string>()
    const unique = entries.filter((entry) => {
      if (seen.has(entry.path)) return false
      seen.add(entry.path)
      return true
    })
    if (unique.length === 0) return null
    const many = unique.length > 1
    const confirmed = await dialog.confirm({
      title: many ? `Discard changes in ${unique.length} files?` : `Discard changes to ${unique[0].relativePath}?`,
      body: (
        <>
          This throws away every change to{' '}
          {many ? `these ${unique.length} files` : unique[0].relativePath} in {activeScopeLabel}. The action
          cannot be undone from here.
          <div className="mt-2 font-mono text-meta text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
        </>
      ),
      confirmLabel: 'Discard changes',
      tone: 'danger',
    })
    if (!confirmed) return null

    return runAction(
      'Discarding changes',
      () => window.api.revertGitPaths(repoRoot!, unique.map((entry) => entry.path)),
      many ? `Discarded changes in ${unique.length} files.` : 'Discarded changes.'
    )
  }

  // --- The checklist: groups, cursor, selection ------------------------------
  // Collapsed rather than expanded is what is remembered, so a group that
  // appears later (T6's changelists) arrives OPEN — the alternative is a new
  // changelist that silently starts folded because nobody had expanded it yet.
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set())
  const expandedGroupIds = useMemo(
    () => new Set(checklistGroups.filter((group) => !collapsedGroupIds.has(group.id)).map((group) => group.id)),
    [checklistGroups, collapsedGroupIds]
  )
  // Every row on screen, in visual order: the keyboard walk, the marquee's
  // geometry and the shift range are all this one list.
  const visibleRows = useMemo(
    () => visibleChangeRows(checklistGroups, (id) => expandedGroupIds.has(id)),
    [checklistGroups, expandedGroupIds]
  )
  const visibleRowsRef = useRef(visibleRows)
  const changeRowNodesRef = useRef<Record<string, HTMLElement | null>>({})
  const selectionAnchorPathRef = useRef<string | null>(null)
  const changeDragRef = useRef<{ startY: number } | null>(null)
  const changeDragCompletedRef = useRef(false)
  // Keyed by PATH alone. The old key was `scope\0path`, because a partially
  // staged file had a row in the Staged section and another in the Unstaged one;
  // it is one row with a dashed box now, so the path is the whole identity.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [cursorPath, setCursorPath] = useState<string | null>(null)

  // Keep the geometry snapshot fresh, drop selection for rows that vanished
  // (committed, discarded, refreshed away) so a stale path never drives a batch
  // action, and hand the cursor to whatever took the row's place rather than
  // dropping it — the list is the tab stop, and a cursor that evaporates on
  // every stage is a keyboard user starting from the top each time.
  useEffect(() => {
    const previousOrder = visibleRowsRef.current.map((row) => row.path)
    const nextOrder = visibleRows.map((row) => row.path)
    visibleRowsRef.current = visibleRows
    setSelectedPaths((current) => {
      if (current.size === 0) return current
      const valid = new Set(nextOrder)
      const next = new Set<string>()
      for (const path of current) if (valid.has(path)) next.add(path)
      return next.size === current.size ? current : next
    })
    setCursorPath((current) => nextCursorPath(previousOrder, nextOrder, current))
  }, [visibleRows])

  useEffect(() => {
    const updateDragSelection = (clientY: number) => {
      if (!changeDragRef.current) return
      const bounds = visibleRowsRef.current
        .map((row) => {
          const node = changeRowNodesRef.current[row.path]
          if (!node) return null
          const rect = node.getBoundingClientRect()
          return { path: row.path, top: rect.top, bottom: rect.bottom }
        })
        .filter((row): row is { path: string; top: number; bottom: number } => Boolean(row))
      const keys = fileExplorerSelectionFromVerticalRange(bounds, changeDragRef.current.startY, clientY)
      changeDragCompletedRef.current = keys.length > 0
      setSelectedPaths(new Set(keys))
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
    // A drag that starts on a row or on a group's band is that control's, not
    // the marquee's — a band click that cleared the selection would make the
    // group checkbox unusable with a selection in hand.
    if (
      event.target instanceof Element
      && event.target.closest('[data-git-change-row="true"], [data-git-group-header="true"]')
    ) {
      return
    }
    event.preventDefault()
    changeDragRef.current = { startY: event.clientY }
    changeDragCompletedRef.current = false
    selectionAnchorPathRef.current = null
    setSelectedPaths(new Set())
  }

  const registerChangeRowNode = (path: string, node: HTMLElement | null) => {
    if (node) changeRowNodesRef.current[path] = node
    else delete changeRowNodesRef.current[path]
  }

  // Returns true when the click was consumed as a selection gesture (marquee
  // suppression, shift-range, or cmd-toggle) and must not also open the diff.
  const handleChangeRowClick = (row: GitChangeRow, event: React.MouseEvent): boolean => {
    if (changeDragCompletedRef.current) return true
    const anchor = selectionAnchorPathRef.current
    if (event.shiftKey && anchor) {
      const keys = fileExplorerSelectionRange(
        visibleRowsRef.current.map((visible) => visible.path),
        anchor,
        row.path
      )
      if (keys.length) setSelectedPaths(new Set(keys))
      setCursorPath(row.path)
      return true
    }
    if (event.metaKey || event.ctrlKey) {
      selectionAnchorPathRef.current = row.path
      setSelectedPaths((current) => {
        const next = new Set(current)
        if (next.has(row.path) && next.size > 1) next.delete(row.path)
        else next.add(row.path)
        return next
      })
      setCursorPath(row.path)
      return true
    }
    selectionAnchorPathRef.current = row.path
    setSelectedPaths(new Set([row.path]))
    setCursorPath(row.path)
    return false
  }

  const handleMoveCursor = (path: string, mode: 'replace' | 'extend') => {
    const anchor = selectionAnchorPathRef.current
    if (mode === 'extend' && anchor) {
      const keys = fileExplorerSelectionRange(
        visibleRowsRef.current.map((visible) => visible.path),
        anchor,
        path
      )
      setSelectedPaths(new Set(keys.length ? keys : [path]))
    } else {
      selectionAnchorPathRef.current = path
      setSelectedPaths(new Set([path]))
    }
    setCursorPath(path)
    changeRowNodesRef.current[path]?.scrollIntoView?.({ block: 'nearest' })
  }

  // A right-click on a row outside the current selection makes that row the
  // selection first, so the menu's batch labels describe exactly the rows the
  // actions will touch. A right-click inside the selection leaves it alone.
  const handleChangeRowContextSelect = (row: GitChangeRow) => {
    if (selectedPaths.has(row.path)) return
    selectionAnchorPathRef.current = row.path
    setSelectedPaths(new Set([row.path]))
    setCursorPath(row.path)
  }

  // The tick IS the index: unchecked and mixed both stage (mixed stages the
  // rest, never unstages the part already in), checked unstages.
  const handleToggleChangeRow = (row: GitChangeRow) => {
    const paths = [row.path]
    void (nextCheckIntent(row.checked) === 'stage' ? stagePaths(paths) : unstagePaths(paths))
  }

  const handleToggleChangeGroup = (group: GitChangeGroup, next: boolean) => {
    // Every row the group holds, not the five hundred on screen: the box
    // governs the group.
    const { action, paths } = groupToggleAction(group.allRows, next)
    if (paths.length === 0) return
    void (action === 'stage' ? stagePaths(paths) : unstagePaths(paths))
  }

  // The rows an action acts on: the selection when the row is part of it (a
  // right-click has already made it so), otherwise the row alone.
  const changeActionRows = (row?: GitChangeRow): GitChangeRow[] => {
    if (row && !selectedPaths.has(row.path)) return [row]
    const selected = visibleRows.filter((visible) => selectedPaths.has(visible.path))
    if (selected.length > 0) return selected
    return row ? [row] : []
  }

  // The row the toolbar's single-file actions mean: the cursor, or the first
  // row of the selection when the cursor is off the list.
  const toolbarTargetRow =
    (cursorPath ? visibleRows.find((row) => row.path === cursorPath) : undefined)
    ?? visibleRows.find((row) => selectedPaths.has(row.path))
    ?? null

  const handleChangeRowsRevert = async (rows: GitChangeRow[]) => {
    if (rows.length === 0) return null
    const batching = rows.length > 1
    const result = await revertEntries(rows)
    if (batching && result !== null) setSelectedPaths(new Set())
    return result
  }

  // Returns whether the commit actually landed, which is what `Commit & Push…`
  // needs: a push after a refused commit pushes whatever was already there and
  // reports success for a commit that never happened.
  const handleCommit = async (): Promise<boolean> => {
    if (!repoRoot) return false
    const result = await runAction(
      'Committing',
      () => window.api.commitGitChanges(repoRoot, commitMessage),
      'Committed changes.'
    )
    if (!result?.ok) return false
    if (commitDraftTimerRef.current) {
      window.clearTimeout(commitDraftTimerRef.current)
      commitDraftTimerRef.current = null
    }
    setCommitMessage('')
    clearGitCommitDraft(workspaceId, activeScopeId)
    return true
  }

  const handleCommitAndPush = async () => {
    if (!(await handleCommit())) return
    await handlePush()
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
            <div className="mt-2 font-mono text-meta text-[color:var(--text-muted)]">{checkedOutElsewhere.path}</div>
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
          reports conflicts, the merge state is left in the working tree for you to resolve.
          <div className="mt-2 font-mono text-meta text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
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
          reports conflicts, the rebase pauses for you to resolve and continue.
          <div className="mt-2 font-mono text-meta text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
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
          Git reports conflicts, the cherry-pick pauses for you to resolve and continue.
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
        ? 'Commits after it are dropped from this branch and every uncommitted change is discarded. The action cannot be undone from here.'
        : mode === 'soft'
          ? 'Commits after it stay in the working tree as staged changes.'
          : 'Commits after it stay in the working tree as unstaged changes.'
    const confirmed = await dialog.confirm({
      title: `Reset ${currentBranch} to ${commit.shortHash}?`,
      body: (
        <>
          This moves <span className="font-mono">{currentBranch}</span> back to “{commit.subject}” ({mode} reset).{' '}
          {consequence}
          <div className="mt-2 font-mono text-meta text-[color:var(--text-muted)]">Scope path: {activeScopePath}</div>
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
          This deletes the stash entry “{entry.message}”. The action cannot be undone from here.
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

  // Activating a changed row shows that file's diff: old content left, new
  // content right, arrow-key hunk navigation that flows across files. WHERE it
  // shows is `openGitDiff`'s to decide — the standalone window by default, the
  // pane's Diff tab once the person has flipped the preference (T3). The scope
  // picks which diff to show first: a staged row shows HEAD↔index, an unstaged
  // row index↔worktree. Tab-opening stays available via the row's "Open file in
  // editor" entry.
  //
  // `repoRoot` is THIS panel's repository — the active scope's, resolved by the
  // panel's own status hook — and it travels with the request. The pane used to
  // re-derive one from the workspace, which is a different repository whenever
  // the panel is showing a worktree scope.
  const openChangeDiff = (row: GitChangeRow, placement: ShowDiffPlacement = 'default') => {
    if (!repoRoot) return
    const request = { workspaceId, repoRoot, focusPath: row.path, scope: row.diffScope }
    if (placement === 'app') {
      // The two explicit placements bypass the preference rather than flipping
      // it: "show it there this once" is not "show it there from now on".
      useWorkspaceStore.getState().openPaneTab(workspaceId, {
        kind: 'diff',
        diff: { repoRoot, focusPath: row.path, focusKind: row.diffScope },
      })
      return
    }
    if (placement === 'window') {
      void openDiffWindow(request)
      return
    }
    openGitDiff(request)
  }

  const handleOpenFileInEditor = async (entry: { path: string; relativePath: string }) => {
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
      <div className="h-full bg-[color:var(--bg-surface)]">
        <EmptyState title="Open a folder to use Git controls." />
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
      <div className="h-full bg-[color:var(--bg-surface)]">
        <EmptyState title="This folder is not a Git repository." />
      </div>
    )
  }

  // The view strip is the kit's `Tabs` (one tab stop, arrow keys, `aria-controls`
  // onto real `tabpanel`s) rather than the panel's own `role="tab"` buttons,
  // which had no keyboard model at all (2026-09-02 audit).
  //
  // Glyph-only since 2026-09-04 (owner): the strip IS the panel's chrome row
  // now, so it has to fit five views and the sync affordances in one 36px band.
  // Every name AND every count rides the tooltip — a badge on the Changes glyph
  // was tried and cut: at two digits it covered the mark it was badging, and a
  // row of five glyphs cannot carry a counter without becoming a row of alarms.
  const gitTabsIdPrefix = `git-panel-${workspaceId}`
  const gitViewTabs: TabItem<GitPanelView>[] = [
    {
      id: 'changes',
      label: 'Changes',
      icon: ChangesViewGlyph,
      tooltip: allEntries.length === 1 ? 'Changes \u00b7 1 file' : `Changes \u00b7 ${allEntries.length} files`,
    },
    {
      id: 'worktrees',
      label: 'Worktrees',
      icon: WorktreesViewGlyph,
      tooltip: worktreeCount === 1 ? 'Worktrees \u00b7 1' : `Worktrees \u00b7 ${worktreeCount}`,
    },
    {
      id: 'log',
      label: 'Log',
      icon: LogViewGlyph,
      tooltip:
        totalCommitCount === 1
          ? 'Log \u00b7 1 commit'
          : `Log \u00b7 ${totalCommitCount.toLocaleString()} commits`,
    },
    {
      id: 'stashes',
      label: 'Stashes',
      icon: StashGlyph,
      tooltip: stashes.length === 1 ? 'Stashes \u00b7 1' : `Stashes \u00b7 ${stashes.length}`,
    },
    { id: 'terminal', label: 'Terminal', icon: TerminalViewGlyph },
  ]

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[color:var(--bg-surface)] text-[color:var(--text-default)]">
      {/*
       * The panel's one chrome row: the view strip on the left, the sync
       * affordances on the right (owner, 2026-09-04).
       *
       * It used to be a PanelHeader reading "Git \u00b7 Up to date" with the view
       * tabs on a second row below it. Both halves of that title were already
       * on screen: the pane tab this panel lives in is labelled "Git", and
       * "Up to date" is what the ABSENCE of the Pull/Push buttons beside it
       * means. So the identity row was a band of chrome that said nothing the
       * surface did not, stacked above the band that did — and the two of them
       * spent 72px of a narrow pane before the first file.
       *
       * One band, and the strip earns it. The views go glyph-only to fit
       * beside the sync cluster; names and counts ride the tooltips. Scope
       * health was the one thing the subtitle carried that nothing else says,
       * so it moves to the notice below rather than being dropped — it is
       * exceptional (Missing / Prunable / Locked), and a warning belongs in a
       * notice, not in a subtitle nobody reads twice.
       */}
      <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] pl-1.5 pr-1.5">
        <TabsScroller className="flex min-w-0 flex-1 items-end self-stretch">
          <Tabs<GitPanelView>
            ariaLabel="Git panel views"
            idPrefix={gitTabsIdPrefix}
            items={gitViewTabs}
            value={activeView}
            onChange={setActiveView}
            iconOnly
            borderless
          />
        </TabsScroller>
        <div className="flex shrink-0 items-center gap-1">
            {behind > 0 ? (
              <Tooltip content={`Pull ${behind} commit${behind === 1 ? '' : 's'}${upstreamLabel ? ` from ${upstreamLabel}` : ''}`} placement="bottom">
                <GhostButton
                  size="xs"
                  onClick={() => void handlePull()}
                  disabled={Boolean(busy)}
                  className="tabular-nums"
                  aria-label={`Pull ${behind} commit${behind === 1 ? '' : 's'}`}
                >
                  <SyncArrowIcon direction="down" />
                  {behind}
                </GhostButton>
              </Tooltip>
            ) : null}
            {ahead > 0 ? (
              <Tooltip content={`Push ${ahead} commit${ahead === 1 ? '' : 's'}${upstreamLabel ? ` to ${upstreamLabel}` : ''}`} placement="bottom">
                <GhostButton
                  size="xs"
                  onClick={() => void handlePush()}
                  disabled={Boolean(busy)}
                  className="tabular-nums"
                  aria-label={`Push ${ahead} commit${ahead === 1 ? '' : 's'}`}
                >
                  <SyncArrowIcon direction="up" />
                  {ahead}
                </GhostButton>
              </Tooltip>
            ) : null}
            {/* The resting sync line the retired header subtitle carried
                ("Up to date", "No upstream", "Checking branch") rides this
                tooltip: it states the calm cases, which are exactly the cases
                where the Pull/Push buttons beside it are absent, so it is
                already next to the thing it explains. */}
            <Tooltip
              content={
                syncSummary
                  ? `Fetch remotes and refresh Git status \u00b7 ${syncSummary}`
                  : 'Fetch remotes and refresh Git status'
              }
              placement="bottom"
            >
              <IconButton
                aria-label="Fetch remotes and refresh Git status"
                onClick={() => void handleFetch()}
                disabled={Boolean(busy)}
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
        </div>
      </div>
      {/*
       * The checkout is not healthy — missing, prunable, or locked. This was
       * the PanelHeader subtitle's one irreplaceable job, and it is a warning,
       * so it lands where the panel already puts warnings.
       */}
      {scopeHealth ? (
        <div className="shrink-0 border-b border-[color:var(--border-subtle)] px-3 py-2">
          <InlineNotice tone="warn">
            <span className="font-medium">{scopeHealth.label}</span>
            {' \u2014 '}
            <span>this worktree cannot be worked in until it is restored.</span>
          </InlineNotice>
        </div>
      ) : null}
      <div className="space-y-1 border-b border-[color:var(--border-subtle)] px-3 pb-2 pt-2">
          {/*
           * A sprint spanning projects works one project at a time, in that
           * project's own checkout — so the project comes first: it decides which
           * branches, worktrees, changes, and commits the rest of the panel is
           * even about. A sprint in a single project has nothing to choose
           * between, so the row never appears and the panel is unchanged.
           */}
          {workspaceWorktrees.length > 1 ? (
            <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2">
              <span className="text-micro text-[color:var(--text-subtle)]">Project</span>
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
            <span className="text-micro text-[color:var(--text-subtle)]">Branch</span>
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
            >
              <span className="text-micro text-[color:var(--text-subtle)]">Worktree</span>
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
                  <GhostButton size="xs" onClick={() => void handleReviewDiff()} disabled={Boolean(busy) || !repoRoot}>
                    Review changes
                  </GhostButton>
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

      {/* The strip that switches these panels is the panel's chrome row at the
          top; only the bodies live here. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <TabPanel idPrefix={gitTabsIdPrefix} tabId="changes" active={activeView === 'changes'} className="flex min-h-0 flex-1 flex-col">
            {/* This band belongs to the list beneath it rather
                than to the pane — which is why it is borderless under the view
                strip's own hairline. */}
            <GitChangesToolbar
              busy={Boolean(busy)}
              hasTarget={Boolean(toolbarTargetRow)}
              onRefresh={() => void refreshAll()}
              onDiscard={() => void handleChangeRowsRevert(changeActionRows(toolbarTargetRow ?? undefined))}
              onStash={() => void handleStashPush()}
              onShowDiff={(placement) => {
                if (toolbarTargetRow) openChangeDiff(toolbarTargetRow, placement)
              }}
              onExpandAll={() => setCollapsedGroupIds(new Set())}
              onCollapseAll={() => setCollapsedGroupIds(new Set(checklistGroups.map((group) => group.id)))}
            />
            {/* Full-bleed: the rows carry their own 8px inset and their fill
                runs to the pane's edges, the way a file list's does. */}
            <div className="min-h-0 flex-1 overflow-y-auto py-1" onMouseDown={beginChangeMarquee}>
              {allEntries.length === 0 ? (
                <div className="px-3 py-2 text-meta text-[color:var(--text-subtle)]">Working tree clean</div>
              ) : (
                <>
                  {conflictEntries.length > 0 ? (
                    <div className="px-3 pt-1">
                      <ConflictGroup
                        entries={conflictEntries}
                        busy={busy}
                        onOpenFile={handleOpenFileInEditor}
                        onResolve={handleResolveConflict}
                      />
                    </div>
                  ) : null}
                  <GitChangesList
                    listId={`git-changes-${workspaceId}`}
                    groups={checklistGroups}
                    visibleRows={visibleRows}
                    expandedGroupIds={expandedGroupIds}
                    onExpandedChange={(groupId, next) =>
                      setCollapsedGroupIds((current) => {
                        const updated = new Set(current)
                        if (next) updated.delete(groupId)
                        else updated.add(groupId)
                        return updated
                      })
                    }
                    selectedPaths={selectedPaths}
                    cursorPath={cursorPath}
                    onToggleRow={handleToggleChangeRow}
                    onToggleGroup={handleToggleChangeGroup}
                    onRowClick={handleChangeRowClick}
                    onActivateRow={(row) => openChangeDiff(row)}
                    onMoveCursor={handleMoveCursor}
                    onSelectAll={() => setSelectedPaths(new Set(visibleRows.map((row) => row.path)))}
                    onContextSelect={handleChangeRowContextSelect}
                    registerRowNode={registerChangeRowNode}
                    buildMenu={(row) =>
                      buildChangeRowMenu({
                        row,
                        selectedCount: changeActionRows(row).length,
                        busy: Boolean(busy),
                        onDiscard: () => void handleChangeRowsRevert(changeActionRows(row)),
                        onShowDiff: () => openChangeDiff(row),
                        onOpenInEditor: () => void handleOpenFileInEditor(row),
                        onStash: () => void handleStashPush(),
                        onRefresh: () => void refreshAll(),
                      })
                    }
                  />
                </>
              )}
            </div>

            <CommitComposer
              busy={busy}
              commitMessage={commitMessage}
              readyToCommit={readyToCommit}
              countsLabel={formatCommitCounts(changeCounts)}
              onCommit={handleCommit}
              onCommitAndPush={handleCommitAndPush}
              onCommitMessageChange={handleCommitMessageChange}
              scopeLabel={activeScopeLabel}
              scopePath={activeScopePath}
            />
        </TabPanel>
        <TabPanel idPrefix={gitTabsIdPrefix} tabId="worktrees" active={activeView === 'worktrees'} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <WorktreeManager
            workspaceId={workspaceId}
            repoRoot={mainRepoRoot ?? repoRoot}
            // The project a worktree opened from here files under, in the app's
            // own spelling — `mainRepoRoot` is git's realpath and under a
            // symlinked root would not match the parent workspace's folderPath.
            // It follows the picked project for a run spanning several, and for
            // a worktree-backed workspace resolves to ITS parent, which is where
            // a worktree cut from here belongs too.
            projectRoot={
              activeRepoEntry?.repoRoot
              ?? (workspace ? workspaceProjectRoot(workspace) : null)
              ?? mainRepoRoot
              ?? repoRoot
            }
            currentBranch={branches?.current ?? null}
            branchOptions={branchOptions.map((branch) => branch.name)}
            mode="tab"
            onChanged={refreshAll}
          />
        </TabPanel>
        <TabPanel idPrefix={gitTabsIdPrefix} tabId="log" active={activeView === 'log'} className="flex min-h-0 flex-1 flex-col">
          <GitGraphView
            state={graph}
            currentBranch={branches?.current ?? null}
            detachedReturnBranch={detachedReturnBranch}
            actions={commitActions}
            onReturnToBranch={(branch) => void handleSwitchBranch(branch)}
            onLoadMore={() => void handleLoadMoreGraph()}
            loadingMore={loadingMoreGraph}
            onRetry={() => void refreshGraph()}
          />
        </TabPanel>
        <TabPanel idPrefix={gitTabsIdPrefix} tabId="stashes" active={activeView === 'stashes'} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <StashList
            stashes={stashes}
            busy={busy}
            onApply={(entry, pop) => void handleStashApply(entry, pop)}
            onDrop={(entry) => void handleStashDrop(entry)}
          />
        </TabPanel>
        <TabPanel idPrefix={gitTabsIdPrefix} tabId="terminal" active={activeView === 'terminal'} className="flex min-h-0 flex-1 flex-col">
          <GitTerminalView
            key={`${workspaceId}:${repoRoot}`}
            workspaceId={workspaceId}
            repoRoot={repoRoot}
            terminalId={`git-${workspaceId}-${terminalIdPart(activeScope?.id ?? repoRoot)}`}
          />
        </TabPanel>
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
            className={`max-h-24 overflow-y-auto rounded-md px-2.5 py-2 text-micro [overflow-wrap:anywhere] ${
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
          <Skeleton className="h-control-sm rounded-sm bg-[color:var(--skeleton-shimmer-high)]" />
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
        <div className="text-meta font-semibold text-[color:var(--tone-error)]">
          Conflicts ({entries.length})
        </div>
      </div>
      <div className="space-y-1">
        {entries.map((entry) => {
          const appearance = getGitStatusAppearance(entry.status)
          const pathParts = splitGitPath(entry.relativePath)
          // Same anatomy as the change rows below: file-type glyph leading,
          // name first, directory after in muted ink.
          const title = (
            <span className="flex min-w-0 items-baseline gap-2 font-mono">
              <span className={`min-w-0 max-w-full shrink-0 truncate font-semibold ${appearance.textClass}`}>{pathParts.filename}</span>
              {pathParts.directory ? (
                <span className="min-w-0 shrink truncate text-micro font-normal text-[color:var(--text-muted)]">
                  {pathParts.directory}
                </span>
              ) : null}
            </span>
          )
          return (
            <div key={`conflict:${entry.path}`} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <InboxRow
                  leading={<FileTypeGlyph name={pathParts.filename} className="icon-sm shrink-0 text-[color:var(--text-muted)]" />}
                  title={title}
                  trailing={<span className="font-mono text-micro font-semibold opacity-80">!</span>}
                  onSelect={() => void onOpenFile(entry)}
                  ariaLabel={`Open ${entry.relativePath}, conflicted`}
                />
              </div>
              <Tooltip content={`Resolve ${entry.relativePath}`}>
                <GhostButton
                  size="xs"
                  onClick={() => onResolve(entry)}
                  disabled={Boolean(busy)}
                  tone="danger"
                  className="shrink-0"
                  aria-label={`Resolve ${entry.relativePath}`}
                >
                  Resolve
                </GhostButton>
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
    return <EmptyState density="list" title="No stashes" />
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
            <TruncatedText
              as="span"
              text={entry.message || 'Stashed changes'}
              className="min-w-0 text-meta text-[color:var(--text-default)]"
            />
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="flex min-w-[7rem] flex-1 items-center gap-1.5 overflow-hidden text-micro text-[color:var(--text-muted)]">
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
                  <GhostButton size="xs" onClick={() => onApply(entry, true)} disabled={Boolean(busy)} aria-label={`Pop ${entry.ref}`}>
                    Pop
                  </GhostButton>
                </Tooltip>
                <Tooltip content={`Reapply ${entry.ref} and keep it`}>
                  <GhostButton size="xs" onClick={() => onApply(entry, false)} disabled={Boolean(busy)} aria-label={`Apply ${entry.ref}`}>
                    Apply
                  </GhostButton>
                </Tooltip>
                <Tooltip content={`Delete ${entry.ref}`}>
                  <GhostButton size="xs" tone="danger" onClick={() => onDrop(entry)} disabled={Boolean(busy)} aria-label={`Drop ${entry.ref}`}>
                    Drop
                  </GhostButton>
                </Tooltip>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function CommitComposer({
  busy,
  commitMessage,
  readyToCommit,
  countsLabel,
  onCommit,
  onCommitAndPush,
  onCommitMessageChange,
  scopeLabel,
  scopePath,
}: {
  busy: string | null
  commitMessage: string
  readyToCommit: boolean
  /** `N of M files` — checked of total. The line the mockup's foot carries. */
  countsLabel: string
  onCommit: () => Promise<boolean>
  onCommitAndPush: () => Promise<void>
  onCommitMessageChange: (value: string) => void
  scopeLabel: string
  scopePath: string
}) {
  return (
    <section className="shrink-0 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-3">
      <div className="mb-2 min-w-0 text-micro text-[color:var(--text-subtle)]">
        <span className="font-medium text-[color:var(--text-muted)]">Commit scope</span>
        <span className="mx-1.5 text-[color:var(--text-disabled)]" aria-hidden="true">/</span>
        {/* The full path is a product tooltip on a keyboard-reachable trigger,
            not a native `title` on a span nobody can tab to. */}
        <Tooltip content={scopePath} multiline>
          <span tabIndex={0} className={`rounded-xs font-mono ${FOCUS_RING_CLASS}`}>
            {scopeLabel}
          </span>
        </Tooltip>
      </div>
      <Textarea
        size="sm"
        resize="none"
        value={commitMessage}
        onChange={(event) => onCommitMessageChange(event.target.value)}
        placeholder="Commit message"
        aria-label="Commit message"
        className="h-16"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        {/*
         * `11 of 26 files` — what the index holds, of what the list shows. It
         * replaces "3 staged", and the difference is not wording: the checkbox
         * IS the index now, so the line states the same fact the boxes do and
         * the Commit button beside it turns on at exactly the same moment.
         *
         * Fetch / Pull / Push left with it. Both counts already ride the panel's
         * chrome row as the arrow buttons that appear when there is anything to
         * pull or push, and a foot with five controls in a 340px pane had none
         * of them readable. What a commit needs is here: commit, or commit and
         * send it.
         */}
        <div className="min-w-0 truncate text-micro text-[color:var(--text-subtle)]">{countsLabel}</div>
        <div className="flex shrink-0 items-center gap-2">
          <PrimaryButton size="md" onClick={() => void onCommit()} disabled={Boolean(busy) || !readyToCommit}>
            Commit
          </PrimaryButton>
          {/* The ellipsis is honest: the push half can still ask (an upstream
              to set, a confirmation), and the commit half runs first — a push
              never follows a commit git refused. */}
          <GhostButton size="md" onClick={() => void onCommitAndPush()} disabled={Boolean(busy) || !readyToCommit}>
            Commit &amp; Push…
          </GhostButton>
        </div>
      </div>
    </section>
  )
}
