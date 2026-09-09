import { useCallback, useEffect, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { refreshSprintEngineWorkspaceProjection } from '../../utils/sprintengineProjectionRefresh'
import { sprintEngineRepoDisplayName } from '../../../../shared/backlog/sprintengine-links'
import type { SprintEngineVcs } from '../../types/workspace'
import { FOCUS_RING_CLASS, PrimaryButton, PullRequestGlyph, Tooltip } from '../ui'
import { PULL_REQUEST_TONE_VAR, pullRequestTone } from '../../../../shared/git/pull-request'

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

// Whether opening the run surface should fire a one-shot GitHub merge-state
// probe: there is a run to probe (state path + vcs), a reason to (the run is done
// or a PR exists), and the PR is not already in a terminal state. Pure and
// export-only so the condition is unit-tested without React.
export function shouldProbePullRequestOnOpen(input: {
  statePath: string | null
  hasVcs: boolean
  prState: PrState
  shouldPoll: boolean
}): boolean {
  const { statePath, hasVcs, prState, shouldPoll } = input
  if (!statePath || !hasVcs || !shouldPoll) return false
  return prState !== 'merged' && prState !== 'closed'
}

// Refresh the PR's merge state once when the run surface opens, so a merge that
// happened while the board was closed shows the moment the user lands on it.
// Periodic background polling is owned by MAIN (`sprintengine-pr-merge-poller.ts`,
// exponential backoff, window-independent), so this holds no interval — one `gh`
// probe on open and nothing more. Keyed on stable primitives; the projection
// refresh mutates `vcs`, so depending on it would re-fire.
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
  const probe = shouldProbePullRequestOnOpen({ statePath, hasVcs, prState, shouldPoll })
  useEffect(() => {
    if (!probe || !statePath) return
    let cancelled = false
    void (async () => {
      try {
        const result = await window.api.refreshSprintEnginePullRequestStatus(statePath)
        if (cancelled || !result.ok) return
        await refreshRef.current()
      } catch {
        // Best-effort: a transient gh/git failure just waits for the supervisor.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [statePath, probe])
}

// The shared create-and-open action: opens the pull request (push + `gh pr
// create`), then opens the resulting PR in the browser so the user lands on it.
// Returns the busy flag and the last failure (a hard IPC error; a `gh`/push
// failure surfaces through the refreshed `vcs`).
function useRunPullRequestAction(input: { workspaceId: string; statePath: string | null }): {
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
  'interactive flex h-6 shrink-0 items-center rounded-sm px-1.5 text-micro font-medium hover:bg-[color:var(--bg-hover)]'

// Merge state of a run branch, shared by every Run-PR source (SprintEngine,
// automations, and any future workspace type that opens a PR from a run branch).
type RunPrState = 'open' | 'merged' | 'closed' | null

// ----------------------------------------------------------------------------
// Generic, source-agnostic presentational core
//
// These two components know nothing about SprintEngine or automations — they
// render a "create the PR" button and a "view the PR" chip from plain props, so
// any run that can open a pull request (the generic Run-PR capability) reuses the
// exact same control. The source-specific wrappers below inject the create action
// and project their own state onto these props.
// ----------------------------------------------------------------------------

// Ink for a chip carrying its pull request's state, from the ONE shared tone map
// (`pullRequestTone`, epic pull-request-marks decision 2) rather than a
// per-surface guess: open in the accent, merged in the violet a landed branch
// already wears, closed in the danger red GitHub itself uses. Closed used to be
// dimmed to `--text-muted` here, which read as "not important" for a state that
// means the work was thrown away, and disagreed with what GitHub shows.
//
// EVERY chip takes it now, including the single-project one that used to stay a
// flat link accent whatever its state. That opt-out predates the marks: once the
// chip draws its state's shape, inking a merged one in the accent — which IS the
// open tone — makes the colour contradict the shape, and decision 2 has colour
// agreeing with shape, never arguing with it.
//
// A run with no pull request at all never reaches here — the chip renders
// nothing without a URL, because nothing is drawn unless a pull request
// definitely exists (decision 3). `null` here therefore means a pull request
// that exists and has not been read back yet, which is OPEN, not a fourth
// state: it takes the open tone, the same way it takes the open mark.
export function runPullRequestChipInk(prState: RunPrState): string {
  return PULL_REQUEST_TONE_VAR[pullRequestTone(prState ?? 'open')]
}

// The calm "view" chip: links to an existing PR. Renders nothing until there is a
// URL, so it never competes with the create CTA at the completion moment. Label
// and aria-label are caller-supplied so each surface keeps its own wording
// (SprintEngine: "View pull request"; automations: "Open PR").
//
// One chip, one appearance: the state's mark, then the caller's label, inked by
// the state. The per-project row a multi-project run shows (MC-1613) and the
// single "View pull request" chip differ only in their words.
function RunPullRequestLinkChip({
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
  // A pull request the app has a URL for exists, and one that exists is open
  // until GitHub says otherwise (decision 3) — so the mark is drawn for every
  // chip, and it is the shape, not the ink, that carries the state. The chip's
  // own label names the project or the action, so the glyph is decorative.
  const state = prState ?? 'open'
  // Inline, like every other tone-driven ink in the kit (`StatusDot`): the value
  // comes from the shared map at render time, so there is no per-state class
  // literal here to fall out of step with it.
  const ink = runPullRequestChipInk(prState)
  return (
    <Tooltip content={prState === 'merged' ? 'Pull request merged — open it' : prState === 'closed' ? 'Pull request closed — open it' : url}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={ariaLabel}
        style={{ color: ink }}
        className={`${CHIP_CLASS} gap-1 ${FOCUS_RING_CLASS}`}
      >
        <PullRequestGlyph state={state} className="icon-xs" />
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
function RunPullRequestActionButton({
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
      {/* One error idiom (MC-2115): creating the pull request FAILED, so this is
          `--tone-error` like every sibling failure — it was the one place in the
          app that coloured a hard failure amber. The button beside it already
          carries the recovery (it reads "Retry" once there is an error), which
          is why the failure can stay a line rather than a card. */}
      {error ? (
        <span
          role="alert"
          className="max-w-[260px] text-right text-micro text-[color:var(--tone-error)] [overflow-wrap:anywhere]"
        >
          {error}
        </span>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------------------
// SprintEngine adapters (thin wrappers over the generic core above)
// ----------------------------------------------------------------------------

// A declared project whose pull request is not open (yet, or because opening it
// failed). The project still gets a chip: dropping it would let a failed project
// read as one that was never part of the sprint, and the row is the only place a
// per-project failure is visible. Static, muted, and never a link — there is
// nothing to open.
function RunPullRequestPendingChip({ label, reason }: { label: string; reason: string }): JSX.Element {
  return (
    <Tooltip content={reason}>
      <span className={`${CHIP_CLASS} text-[color:var(--text-disabled)]`} aria-label={`${label}: ${reason}`}>
        {label}
      </span>
    </Tooltip>
  )
}

// Once a PR exists, linking to it is routine — this calm chip carries that "View"
// state in the board chrome, reachable across every tab.
//
// A run spanning projects (MC-1613) delivers one branch — and one pull request —
// per project, so it shows one chip per project, each labelled with that project's
// name and colored by its OWN merge state: one project's PR can be merged while
// another's is still open. A run in a single project is unchanged: one chip,
// reading "View pull request", in the link accent.
export function RunPullRequestViewChip({
  vcs,
  folderPath,
}: {
  vcs?: SprintEngineVcs | null
  folderPath?: string | null
}): JSX.Element | null {
  const repos = vcs?.repos ?? []
  if (repos.length <= 1) {
    return (
      <RunPullRequestLinkChip
        url={vcs?.pullRequestUrl ?? null}
        prState={vcs?.pullRequestState ?? null}
        label="View pull request"
        ariaLabel="View the pull request for this sprint"
      />
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {repos.map((repo) => {
        const name = sprintEngineRepoDisplayName({ workspaceRoot: folderPath ?? '', root: repo.root })
        return repo.pullRequestUrl ? (
          <RunPullRequestLinkChip
            key={repo.id}
            url={repo.pullRequestUrl}
            prState={repo.pullRequestState ?? null}
            label={name}
            ariaLabel={`View the ${name} pull request for this sprint`}
          />
        ) : (
          <RunPullRequestPendingChip
            key={repo.id}
            label={name}
            reason={repo.pullRequestError ?? 'No pull request opened for this project yet'}
          />
        )
      })}
    </span>
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
  const repos = vcs.repos ?? []
  // A run spanning projects opens one pull request per project in a single call,
  // per project, and failure is per project too: the desktop's can open while the
  // phone's push fails. The action therefore has to survive a partial success —
  // reading the primary's URL alone retired the button the moment ITS pull request
  // existed, stranding a failed project with a visible error and no way to retry,
  // even though re-running opens exactly the ones still missing.
  if (repos.length > 1) {
    const outstanding = repos.filter((repo) => !repo.pullRequestUrl && repo.pullRequestState !== 'merged')
    if (outstanding.length === 0) return null
    const firstFailure = repos.find((repo) => repo.pullRequestError)?.pullRequestError ?? null
    const someOpened = repos.some((repo) => repo.pullRequestUrl)
    return (
      <RunPullRequestActionButton
        pullRequestUrl={null}
        pullRequestState={null}
        busy={busy}
        error={actionError ?? firstFailure}
        disabled={!statePath}
        onCreate={createPullRequest}
        // Naming what is left is the honest label once some projects already have
        // one: "Open pull request" would read as if none existed.
        createLabel={someOpened ? 'Open remaining pull requests' : 'Open pull requests'}
        retryLabel="Retry pull requests"
        busyLabel="Opening…"
        ariaLabel={`Open pull requests for the ${outstanding.length} remaining ${outstanding.length === 1 ? 'project' : 'projects'} in this sprint`}
      />
    )
  }
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
