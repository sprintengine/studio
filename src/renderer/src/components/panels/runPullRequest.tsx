import { useCallback, useEffect, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { refreshSprintEngineWorkspaceProjection } from '../../utils/sprintengineProjectionRefresh'
import type { SprintEngineVcs } from '../../types/workspace'
import { FOCUS_RING_CLASS, PrimaryButton, Tooltip } from '../ui'

// How often the run polls GitHub for the PR's merge state while the workspace is
// open. One `gh pr view` per tick, for the active run, until it merges/closes.
// The always-on supervisor runs the gentler background sweep for closed runs.
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

// Poll the PR's merge state while a run is open. Immediate on mount, then every
// PR_MERGE_POLL_MS, stopping once the branch is merged or the PR closed. Depends
// on stable primitives, never the `vcs` object — each poll refreshes the
// projection (new `vcs` identity), and re-running the effect on that would
// restart the interval and poll again immediately (a tight loop).
export function useRunPullRequestMergePoll(input: {
  workspaceId: string
  statePath: string | null
  hasVcs: boolean
  prState: PrState
  shouldPoll: boolean
}): void {
  const { workspaceId, statePath, hasVcs, prState, shouldPoll } = input
  const refresh = useRunProjectionRefresh(workspaceId)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const terminal = prState === 'merged' || prState === 'closed'
  useEffect(() => {
    if (!statePath || !hasVcs || terminal || !shouldPoll) return
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
    const timer = window.setInterval(poll, PR_MERGE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [statePath, hasVcs, terminal, shouldPoll])
}

// The shared create/open action. Returns the busy flag and the last failure (a
// hard IPC error; a `gh`/push failure surfaces through the refreshed `vcs`).
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
      if (!result.ok) setActionError(result.message ?? 'Opening the pull request failed.')
      await refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [statePath, busy, refresh])
  return { busy, actionError, createPullRequest }
}

const CHIP_CLASS =
  'interactive flex h-6 shrink-0 items-center rounded-[5px] px-1.5 text-[11px] font-medium transition-colors hover:bg-[color:var(--bg-hover)]'

// The PR control is split by altitude. Opening the pull request is the sprint's
// culminating action, so it lives at full weight in the run-complete banner
// (`RunCompletePullRequestAction`). Once a PR exists, linking to it is routine —
// this calm chip carries that "View" state in the board chrome, reachable across
// every tab. It renders nothing until there's a URL to link, so it never competes
// with the banner's create CTA at the completion moment.
export function RunPullRequestViewChip({ vcs }: { vcs?: SprintEngineVcs | null }): JSX.Element | null {
  const url = vcs?.pullRequestUrl ?? null
  const prState = vcs?.pullRequestState ?? null
  if (!url) return null
  return (
    <Tooltip content={prState === 'merged' ? 'Pull request merged — open it' : prState === 'closed' ? 'Pull request closed — open it' : url}>
      <a href={url} target="_blank" rel="noreferrer" aria-label="View the pull request for this sprint" className={`${CHIP_CLASS} text-[color:var(--accent-primary)] ${FOCUS_RING_CLASS}`}>
        View pull request
      </a>
    </Tooltip>
  )
}

// The culminating action for a completed worktree run: push the branch and open
// the pull request. A full-weight primary button — this is the one place the
// create action earns presence — shown only at the completion moment, before a
// PR exists. A failure swaps the label to "Retry" and surfaces the reason inline
// (the banner has the room a header tooltip didn't). Renders nothing for a
// non-worktree run (no branch to review), once a PR exists (the view chip takes
// over), or once the branch has merged.
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
  const url = vcs?.pullRequestUrl ?? null
  const prState = vcs?.pullRequestState ?? null
  if (!vcs || url || prState === 'merged') return null

  const failed = vcs.status === 'failed'
  const error = actionError ?? (failed ? vcs.pullRequestError ?? 'The last pull-request open failed.' : null)
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <PrimaryButton
        onClick={() => void createPullRequest()}
        disabled={busy || !statePath}
        aria-label="Open a pull request for this sprint"
      >
        {busy ? 'Opening…' : error ? 'Retry pull request' : 'Open pull request'}
      </PrimaryButton>
      {error ? (
        <span className="max-w-[260px] text-right text-[11px] text-[color:var(--tone-warn)] [overflow-wrap:anywhere]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
