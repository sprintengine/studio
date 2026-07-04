import { useCallback, useEffect, useRef, useState } from 'react'

import { isSprintEngineWorkspaceDormant } from '../../utils/sprintengineAutomationLifecycle'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { refreshSprintEngineWorkspaceProjection } from '../../utils/sprintengineProjectionRefresh'
import type { SprintEngineVcs } from '../../types/workspace'
import { FOCUS_RING_CLASS, PrimaryButton, Tooltip } from '../ui'

// How often a live run polls GitHub for the PR's merge state while the workspace
// is open. One `gh pr view` per tick, until the PR merges/closes or the run goes
// dormant. A dormant run never holds this interval — it refreshes once when the
// surface opens (on-demand), then stops, so no periodic `gh` runs while it idles.
export const PR_MERGE_POLL_MS = 30_000

// Pull the freshly-written projection into the store after a vcs mutation so the
// header chip, the summary row, and the run glyph all reflect the new state.
function useRunProjectionRefresh(workspaceId: string): () => Promise<void> {
  return useCallback(async () => {
    const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    await refreshSprintEngineWorkspaceProjection({
      workspace,
      tokens: new Map(),
      cause: 'manual',
      force: true,
    })
  }, [workspaceId])
}

type PrState = 'open' | 'merged' | 'closed' | null

// What the merge-poll effect should do for a run, from stop-condition inputs:
//   'off'  — nothing to check (no state path / vcs / poll reason, or the PR is
//            already merged/closed, a permanent terminal state).
//   'once' — refresh exactly once when the surface opens, then stop. A dormant
//            run (T1's terminal lifecycle bit) is never a live poll target: an
//            open PR on it is "pending" metadata, not a merge to watch for.
//   'poll' — refresh on open, then keep polling at PR_MERGE_POLL_MS. The live
//            open run, exactly as before dormancy existed.
// Pure and export-only so the stop condition is unit-tested without React.
export function prMergePollMode(input: {
  statePath: string | null
  hasVcs: boolean
  prState: PrState
  shouldPoll: boolean
  dormant: boolean
}): 'off' | 'once' | 'poll' {
  const { statePath, hasVcs, prState, shouldPoll, dormant } = input
  if (!statePath || !hasVcs || !shouldPoll) return 'off'
  if (prState === 'merged' || prState === 'closed') return 'off'
  return dormant ? 'once' : 'poll'
}

// Keep the PR's merge state fresh while a run is open. Refreshes once on mount
// (the on-demand open refresh) and, for a live run, again every PR_MERGE_POLL_MS
// until the PR merges/closes or the run goes dormant — a dormant run refreshes
// once and stops, never holding a live interval. Depends on stable primitives,
// never the `vcs` object — each poll refreshes the projection (new `vcs`
// identity), and re-running the effect on that would restart the interval and
// poll again immediately (a tight loop). `dormant` is read reactively from the
// store so the interval tears down the moment the run transitions to complete.
export function useRunPullRequestMergePoll(input: {
  workspaceId: string
  statePath: string | null
  hasVcs: boolean
  prState: PrState
  shouldPoll: boolean
}): void {
  const { workspaceId, statePath, hasVcs, prState, shouldPoll } = input
  const dormant = useWorkspaceStore((state) =>
    isSprintEngineWorkspaceDormant(state.workspaces.find((w) => w.id === workspaceId)),
  )
  const refresh = useRunProjectionRefresh(workspaceId)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const mode = prMergePollMode({ statePath, hasVcs, prState, shouldPoll, dormant })
  useEffect(() => {
    if (mode === 'off' || !statePath) return
    let cancelled = false
    const poll = async () => {
      try {
        const result = await window.api.refreshSprintEnginePullRequestStatus(statePath)
        if (cancelled || !result.ok) return
        await refreshRef.current()
      } catch {
        // Best-effort: a transient gh/git failure just retries next tick.
      }
    }
    void poll()
    if (mode === 'once') return () => {
      cancelled = true
    }
    const timer = window.setInterval(poll, PR_MERGE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [statePath, mode])
}

// The shared create-and-open action: opens the pull request (push + `gh pr
// create`), then opens the resulting PR in the browser so the user lands on it.
// Returns the busy flag and the last failure (a hard IPC error; a `gh`/push
// failure surfaces through the refreshed `vcs`).
export function useRunPullRequestAction(input: { workspaceId: string; statePath: string | null }): {
  busy: boolean
  actionError: string | null
  createPullRequest: () => Promise<void>
} {
  const { workspaceId, statePath } = input
  const refresh = useRunProjectionRefresh(workspaceId)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const createPullRequest = useCallback(async () => {
    if (!statePath || busy) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await window.api.createSprintEnginePullRequest(statePath)
      // Refresh first so the projection carries the new pullRequestUrl/status.
      await refresh()
      if (!result.ok) {
        setActionError(result.message ?? 'Opening the pull request failed.')
        return
      }
      // Land the user on the PR they just created. The URL comes from the
      // refreshed projection (authoritative); a push-succeeded-but-PR-failed run
      // leaves it null and surfaces the reason through `vcs` instead. The header
      // "View pull request" chip remains a fallback if the browser open fails.
      const url =
        useWorkspaceStore
          .getState()
          .workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.vcs?.pullRequestUrl ?? null
      if (url) await window.api.openExternal(url)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [statePath, busy, refresh, workspaceId])
  return { busy, actionError, createPullRequest }
}

const CHIP_CLASS =
  'interactive flex h-6 shrink-0 items-center rounded-[5px] px-1.5 text-[11px] font-medium transition-colors hover:bg-[color:var(--bg-hover)]'

// Merge state of a run branch, shared by every Run-PR source (SprintEngine,
// automations, and any future workspace type that opens a PR from a run branch).
export type RunPrState = 'open' | 'merged' | 'closed' | null

// ----------------------------------------------------------------------------
// Generic, source-agnostic presentational core
//
// These two components know nothing about SprintEngine or automations — they
// render a "create the PR" button and a "view the PR" chip from plain props, so
// any run that can open a pull request (the generic Run-PR capability) reuses the
// exact same control. The source-specific wrappers below inject the create action
// and project their own state onto these props.
// ----------------------------------------------------------------------------

// The calm "view" chip: links to an existing PR. Renders nothing until there is a
// URL, so it never competes with the create CTA at the completion moment. Label
// and aria-label are caller-supplied so each surface keeps its own wording
// (SprintEngine: "View pull request"; automations: "Open PR").
export function RunPullRequestLinkChip({
  url,
  prState,
  label,
  ariaLabel,
}: {
  url: string | null
  prState: RunPrState
  label: string
  ariaLabel: string
}): JSX.Element | null {
  if (!url) return null
  return (
    <Tooltip content={prState === 'merged' ? 'Pull request merged — open it' : prState === 'closed' ? 'Pull request closed — open it' : url}>
      <a href={url} target="_blank" rel="noreferrer" aria-label={ariaLabel} className={`${CHIP_CLASS} text-[color:var(--accent-primary)] ${FOCUS_RING_CLASS}`}>
        {label}
      </a>
    </Tooltip>
  )
}

// The full-weight create action: a primary button that runs the injected
// `onCreate` (push + open the PR). Shown only before a PR exists and before the
// branch merges; a failure swaps the label to the retry wording and surfaces the
// reason inline. Source-agnostic — the caller owns the create action, the busy
// flag, the error string, and the labels.
export function RunPullRequestActionButton({
  pullRequestUrl,
  pullRequestState,
  busy,
  error,
  disabled,
  onCreate,
  createLabel,
  retryLabel,
  busyLabel,
  ariaLabel,
}: {
  pullRequestUrl: string | null
  pullRequestState: RunPrState
  busy: boolean
  error: string | null
  disabled?: boolean
  onCreate: () => void | Promise<void>
  createLabel: string
  retryLabel: string
  busyLabel: string
  ariaLabel: string
}): JSX.Element | null {
  if (pullRequestUrl || pullRequestState === 'merged') return null
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <PrimaryButton
        onClick={() => void onCreate()}
        disabled={busy || disabled}
        aria-label={ariaLabel}
      >
        {busy ? busyLabel : error ? retryLabel : createLabel}
      </PrimaryButton>
      {error ? (
        <span className="max-w-[260px] text-right text-[11px] text-[color:var(--tone-warn)] [overflow-wrap:anywhere]">
          {error}
        </span>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------------------
// SprintEngine adapters (thin wrappers over the generic core above)
// ----------------------------------------------------------------------------

// Once a PR exists, linking to it is routine — this calm chip carries that "View"
// state in the board chrome, reachable across every tab.
export function RunPullRequestViewChip({ vcs }: { vcs?: SprintEngineVcs | null }): JSX.Element | null {
  return (
    <RunPullRequestLinkChip
      url={vcs?.pullRequestUrl ?? null}
      prState={vcs?.pullRequestState ?? null}
      label="View pull request"
      ariaLabel="View the pull request for this sprint"
    />
  )
}

// The culminating action for a completed sprint worktree run: push the branch and
// open the pull request. Renders nothing for a non-worktree run (no branch), once
// a PR exists (the view chip takes over), or once the branch has merged.
export function RunCompletePullRequestAction({
  workspaceId,
  statePath,
  vcs,
}: {
  workspaceId: string
  statePath: string | null
  vcs?: SprintEngineVcs | null
}): JSX.Element | null {
  const { busy, actionError, createPullRequest } = useRunPullRequestAction({ workspaceId, statePath })
  if (!vcs) return null
  const failed = vcs.status === 'failed'
  const error = actionError ?? (failed ? vcs.pullRequestError ?? 'The last pull-request open failed.' : null)
  return (
    <RunPullRequestActionButton
      pullRequestUrl={vcs.pullRequestUrl ?? null}
      pullRequestState={vcs.pullRequestState ?? null}
      busy={busy}
      error={error}
      disabled={!statePath}
      onCreate={createPullRequest}
      createLabel="Open pull request"
      retryLabel="Retry pull request"
      busyLabel="Opening…"
      ariaLabel="Open a pull request for this sprint"
    />
  )
}
