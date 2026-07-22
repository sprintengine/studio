import { useWorkspaceStore } from '../store/workspaceStore'
import type {
  BacklogItemLinkPayload,
  BacklogMutationResult,
  BacklogReadResult,
  SprintEngineProjectionReadResult,
} from '../../../shared/electron-api'
import type { DiagnosticLogInput } from '../types/workspace'
import type { SprintEngineState, Workspace, WorkspaceId } from '../types/workspace'
import type { SprintEngineAutomationEvent } from '../types/workspace'
import { publishDiagnostic } from './diagnostics'
import { logPerfEvent } from './perfDiagnostics'
import { isSprintEngineWorkspaceDormant } from './sprintengineAutomationLifecycle'
import { isBacklogEpicPath } from './backlogEpics'
import { isCanceledSprintEngineRun, isCompletedSprintEngineRun, normalizeSprintEngineProjection } from './sprintengine'
import {
  buildSprintEnginePullRequestLink,
  sprintEnginePullRequestLinksOf,
  sprintEngineRepoDisplayName,
  sprintEngineStatePathForBacklogLink,
} from './sprintengineBacklogLinks'
import { tearDownCompletedSprintRunAgents } from './sprintengineRunTeardown'

export type SprintEngineProjectionRefreshCause = 'supervisor' | 'auto-run' | 'manual' | 'mutation'

export type SprintEngineProjectionRefreshResult =
  | { status: 'changed'; state: SprintEngineState }
  | { status: 'unchanged'; state: SprintEngineState | null }
  | { status: 'skipped'; reason: 'missing-context' }
  // `permanent` mirrors the reader's verdict (run directory gone, or a store
  // this build cannot read): no retry heals it, so pollers stop re-polling the
  // workspace instead of re-failing — and re-notifying — every tick.
  | { status: 'error'; message: string; permanent: boolean }

// Carries the reader's `permanent` verdict through the refresh's single
// error-handling path so the catch can distinguish it from transient failures.
class SprintEngineProjectionReadError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message)
  }
}

export type SprintEngineProjectionRefreshPorts = {
  readSprintEngineProjection(statePath: string, knownToken?: string): Promise<SprintEngineProjectionReadResult>
  setSprintEngineState(workspaceId: WorkspaceId, state: SprintEngineState | null): void
  applySprintEngineAutomationEvent?(workspaceId: WorkspaceId, event: SprintEngineAutomationEvent): void
  readBacklogObjectStore?(workspaceRoot: string): Promise<BacklogReadResult>
  addOrUpdateBacklogLink?(input: {
    workspaceRoot: string
    relativePath: string
    link: BacklogItemLinkPayload
    status?: 'completed'
  }): Promise<BacklogMutationResult>
  publishDiagnostic?(input: DiagnosticLogInput): Promise<unknown> | unknown
  // Remove the completed run's agent panels (recording each resumable session
  // first). Injected for testability; defaults to the real teardown.
  tearDownCompletedRunAgents?(workspaceId: WorkspaceId): Promise<unknown> | unknown
  // One-shot completion-teardown marker on sprintEngineAutoState: set after
  // teardown resolves, cleared when the run's tasks are no longer all done.
  setCompletionTeardownAt?(workspaceId: WorkspaceId, at: number | undefined): void
  now?(): number
}

function defaultSprintEngineProjectionRefreshPorts(): SprintEngineProjectionRefreshPorts {
  return {
    readSprintEngineProjection: (statePath, knownToken) =>
      window.api.readSprintEngineProjection(statePath, knownToken),
    setSprintEngineState: (workspaceId, state) =>
      useWorkspaceStore.getState().setSprintEngineState(workspaceId, state),
    applySprintEngineAutomationEvent: (workspaceId, event) =>
      useWorkspaceStore.getState().applySprintEngineAutomationEvent(workspaceId, event),
    readBacklogObjectStore: (workspaceRoot) => window.api.readBacklogObjectStore(workspaceRoot),
    addOrUpdateBacklogLink: (input) => window.api.addOrUpdateBacklogLink(input),
    publishDiagnostic: (input) => publishDiagnostic(input),
    tearDownCompletedRunAgents: (workspaceId) => tearDownCompletedSprintRunAgents(workspaceId),
    setCompletionTeardownAt: (workspaceId, at) =>
      useWorkspaceStore.getState().setSprintEngineCompletionTeardownAt(workspaceId, at),
  }
}

export async function refreshSprintEngineWorkspaceProjection(input: {
  workspace: Workspace
  // Per-workspace change-detection tokens (mtime:size of projection.json),
  // keyed by workspace id. Used to skip re-reading unchanged projections.
  tokens: Map<string, string>
  cause: SprintEngineProjectionRefreshCause
  force?: boolean
  ports?: SprintEngineProjectionRefreshPorts
}): Promise<SprintEngineProjectionRefreshResult> {
  const { workspace, tokens, cause, force = false } = input
  const ports = input.ports ?? defaultSprintEngineProjectionRefreshPorts()

  if (!workspace.sprintEngineContext?.statePath) {
    return { status: 'skipped', reason: 'missing-context' }
  }

  const startedAt = ports.now?.() ?? performance.now()
  // A dormant workspace (lifecycle already `complete`) does DISPLAY-only work: it
  // may read + `setSprintEngineState` to hydrate a cold-restarted board, but runs
  // no lifecycle — no reconcile, teardown, or backlog-link write. A finished run's
  // projection is terminal, so no source can re-run lifecycle on it, which is what
  // keeps a deliberately re-opened terminal from being torn down. The full path is
  // reserved for non-dormant runs, where reconcile may transition the run into
  // dormancy exactly once (via `enterSprintEngineDormancy`). Decided from the
  // passed-in snapshot at entry: on the transition tick the store still reads
  // non-complete (the event applies asynchronously), so the full path runs once
  // then subsequent refreshes see dormant and go display-only.
  const dormant = isSprintEngineWorkspaceDormant(workspace)
  try {
    // On a forced refresh, pass no token so the reader always returns full data.
    const knownToken = force ? undefined : tokens.get(workspace.id)
    const projectionResult = await ports.readSprintEngineProjection(
      workspace.sprintEngineContext.statePath,
      knownToken,
    )
    if (!projectionResult.ok) {
      throw new SprintEngineProjectionReadError(projectionResult.message, projectionResult.permanent === true)
    }

    if (projectionResult.unchanged) {
      // The projection bytes are unchanged, but the automation lifecycle may
      // still be out of sync with a run that already finished — e.g. a run that
      // completed and was then demoted to `paused` by an end-of-run agent
      // terminal close. `runner_complete` otherwise only fires on a changed
      // poll, so a stably-finished run would never self-heal. Reconcile from the
      // already-parsed stored state on every tick instead. A dormant run is past
      // that: its display is already set and no lifecycle work remains.
      if (!dormant) {
        reconcileCompletedRunLifecycle(workspace, workspace.sprintEngineState, ports)
      } else {
        healInterruptedDormancyTeardown(workspace, ports)
      }
      logPerfEvent('SprintEngineProjection', 'refresh', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cause,
        changed: false,
        elapsedMs: Math.round((ports.now?.() ?? performance.now()) - startedAt),
      })
      return { status: 'unchanged', state: workspace.sprintEngineState }
    }

    const parsedState = normalizeSprintEngineProjection(
      projectionResult.data,
      workspace.sprintEngineContext.teamSlug,
    )
    if (!parsedState) throw new Error('Sprint projection was malformed.')

    // Record the new token so the next poll can short-circuit when nothing
    // changed. If the reader did not return one, drop any stale token so we
    // re-read next time rather than dedupe against a fingerprint we don't have.
    if (projectionResult.token) tokens.set(workspace.id, projectionResult.token)
    else tokens.delete(workspace.id)
    ports.setSprintEngineState(workspace.id, parsedState)
    // Display-only for dormant runs (see the entry comment): hydrate the board,
    // skip lifecycle + backlog. Non-dormant runs get the full path, where
    // reconcile may flip the run into dormancy on this very tick.
    if (!dormant) {
      reconcileCompletedRunLifecycle(workspace, parsedState, ports)
      await refreshBacklogSprintEngineRunLinks({
        workspace,
        state: parsedState,
        ports,
      })
    } else {
      healInterruptedDormancyTeardown(workspace, ports)
      // A dormant *canceled* run still recolors its Backlog run-link chip. Cancel
      // reaches its terminal `canceled` state via the runtime broadcast, so the
      // workspace is already dormant when the first post-cancel refresh reads the
      // canceled projection — there is no non-dormant completing tick to write the
      // chip (unlike completion, whose link lands on its non-dormant tick). Run it
      // on any dormant tick that first reads the run canceled, forced OR routine:
      // without it a routine-only teardown would leave the chip Active forever.
      // This is the changed-projection branch, so it fires once (on the first read
      // of the canceled projection); after it, `canStopPolling…` quiesces the poll.
      // Idempotent regardless: the link refresh self-skips once the chip matches.
      // Scoped to cancellation so a completed dormant run stays display-only.
      if (isCanceledSprintEngineRun(parsedState)) {
        await refreshBacklogSprintEngineRunLinks({
          workspace,
          state: parsedState,
          ports,
        })
      }
    }
    logPerfEvent('SprintEngineProjection', 'refresh', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      changed: true,
      elapsedMs: Math.round((ports.now?.() ?? performance.now()) - startedAt),
      taskCount: parsedState.tasks.length,
      artifactCount: parsedState.artifacts.length,
      source: parsedState.projection?.source ?? 'unavailable',
    })
    return { status: 'changed', state: parsedState }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const permanent = error instanceof SprintEngineProjectionReadError && error.permanent
    // A permanent failure on a background cause stays out of the notification
    // feed: the pollers give up on the workspace after this result, but dozens
    // of stale workspaces (runs archived out of the repo, pre-v2 stores) would
    // each notify once per launch. Interactive causes still notify — the user
    // acted on this workspace and needs to see why nothing loaded.
    const background = cause === 'supervisor' || cause === 'auto-run'
    if (!(permanent && background)) {
      await ports.publishDiagnostic?.({
        level: 'warning',
        source: 'sprintengine',
        title: 'Sprint projection refresh failed',
        message,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      })
    }
    logPerfEvent('SprintEngineProjection', 'refresh-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      message,
      permanent,
      elapsedMs: Math.round((ports.now?.() ?? performance.now()) - startedAt),
    })
    return { status: 'error', message, permanent }
  }
}

// The ports `enterSprintEngineDormancy` needs: the completion event applier, the
// one-shot teardown, its marker setter, and the clock. A subset of the refresh
// ports so the projection reconcile can hand its own ports straight through, and
// the auto-run supervisor's hard-completion gate can build a compatible object.
export type SprintEngineDormancyPorts = Pick<
  SprintEngineProjectionRefreshPorts,
  'applySprintEngineAutomationEvent' | 'tearDownCompletedRunAgents' | 'setCompletionTeardownAt' | 'now'
>

// The single completion transition: fire `runner_complete` once, then tear down
// the run's agent panels exactly once. Centralized so every completion-entry path
// (the projection reconcile below, and the auto-run supervisor's hard-completion
// gate) enters dormancy identically — teardown bound to the transition, not to a
// follow-up poll, because dormancy stops the poller that used to run it. Idempotent
// on repeat calls: the reducer's terminal-state gate no-ops the re-fired event, and
// the persisted marker no-ops the re-run teardown.
export function enterSprintEngineDormancy(
  workspace: Pick<Workspace, 'id' | 'sprintEngineAutoState'>,
  ports: SprintEngineDormancyPorts,
): void {
  // Fire the lifecycle transition once (the runtime-state gate keeps this from
  // churning the store on every caller).
  if (workspace.sprintEngineAutoState?.runtimeState !== 'complete') {
    ports.applySprintEngineAutomationEvent?.(workspace.id, {
      type: 'runner_complete',
      message: 'All tasks are complete.',
    })
  }

  // Remove the run's agent panels (recording each resumable session first) —
  // exactly ONCE per completion. The marker, not "do sprint agents exist",
  // gates the teardown: agent records legitimately reappear after it ran
  // (`reconcileSprintEngineAgents` recreates roster records on every projection
  // read, and the board resume path re-opens a role's panel on purpose), so an
  // agent-presence gate would tear those straight back down. The marker is set
  // only after the teardown resolves, so a teardown interrupted by an app quit
  // retries on the next entry — including the reload case, where the run is
  // already dormant and the refresh's display-only branch re-enters here via
  // `healInterruptedDormancyTeardown`. It owns completion teardown for every
  // automation mode, including a run reopened after the app restarted.
  if (workspace.sprintEngineAutoState?.completionTeardownAt === undefined) {
    void (async () => {
      await ports.tearDownCompletedRunAgents?.(workspace.id)
      ports.setCompletionTeardownAt?.(workspace.id, ports.now?.() ?? Date.now())
    })().catch(() => {
      // Leave the marker unset so the next entry retries the teardown.
    })
  }
}

// Heal a dormant run whose completion teardown never finished. An app quit
// during the fire-and-forget teardown persists `runtimeState:'complete'` with
// the marker still unset, so on reload the run is already dormant and the
// display-only branch skips every lifecycle path — teardown never resolves, the
// marker never sets, and `canStopPollingCompletedSprintEngineProjection` stays
// false forever, so the projection poller never quiesces. `enterSprintEngine-
// Dormancy` is the fix: on an already-`complete` run its runtime guard fires no
// lifecycle event, so it only runs the marker-gated teardown and sets the
// marker — completing the pending teardown without breaking the display-only
// contract (no reconcile, no backlog writes). Gated on the marker being unset so
// a fully torn-down dormant run stays a strict no-op (0 teardowns, 0 writes).
function healInterruptedDormancyTeardown(
  workspace: Workspace,
  ports: SprintEngineProjectionRefreshPorts,
): void {
  if (workspace.sprintEngineAutoState?.completionTeardownAt === undefined) {
    enterSprintEngineDormancy(workspace, ports)
  }
}

// Bring the automation lifecycle in line with a run whose tasks are all done.
// Task-completeness (not the raw projection `run.status`) is the canonical
// "run finished" signal used by the auto-run supervisor and Backlog links, and
// it is the only completion signal available on the parsed state for unchanged
// polls. Only reached on the non-dormant path (dormant runs are display-only),
// so this is where a run first transitions into dormancy — and the only place
// the scope-expansion marker re-arm is reachable, since a re-opened run has left
// `complete` and is non-dormant again.
function reconcileCompletedRunLifecycle(
  workspace: Workspace,
  state: SprintEngineState | null,
  ports: SprintEngineProjectionRefreshPorts,
): void {
  if (!state) return

  // A canceled run reaches dormancy through the runtime's cancellation broadcast
  // (terminal runtimeState `canceled`), never through completion. Its non-done
  // tasks are all `canceled`, so `isCompletedSprintEngineRun` reads true — but
  // entering COMPLETION dormancy here would fire `runner_complete` and, if it
  // wins the race with the cancel broadcast, flip the terminal runtimeState to
  // `complete`, mislabeling a canceled run as completed (the reducer's terminal
  // guard then ignores the later `runner_canceled`). Leave cancellation to the
  // runtime; the chip recolor still runs after this via refreshBacklog…RunLinks.
  if (isCanceledSprintEngineRun(state)) return

  if (!isCompletedSprintEngineRun(state)) {
    // A formerly-complete run gained open tasks again (scope expansion, sprint
    // chaining): re-arm the one-shot teardown for the next completion.
    if (workspace.sprintEngineAutoState?.completionTeardownAt !== undefined) {
      ports.setCompletionTeardownAt?.(workspace.id, undefined)
    }
    return
  }

  enterSprintEngineDormancy(workspace, ports)
}

// Whether the projection poller can stop reading a workspace's projection.json.
// A terminal run — completed OR canceled — won't change again. Cancellation is
// handled first: a canceled run's runtimeState is `canceled`, so the completion
// arm never matched it and the poller read it forever (the bug this fixes). It
// stops once the hydrated state itself reads canceled (`isCanceledSprintEngineRun`)
// and the shared teardown has run — the hydration guard ensures the one read that
// recolors the Backlog chip happens first. The completion arm below needs three
// conditions, plus one empty-graph carve-out:
//   1. lifecycle `complete` (not raw task-completeness): a run that finished but
//      is still stuck in `paused` must keep polling so `reconcileCompletedRun-
//      Lifecycle` can self-heal it to `complete` first; the next tick skips it.
//   2. the hydrated `sprintEngineState` ITSELF reads complete: the projection is
//      intentionally not persisted across sessions
//      (`normalizeWorkspaceForPartialize` nulls it to avoid a localStorage
//      write-storm), so a cold `complete` run after an app restart still needs
//      one read to populate the board and run summary — and a merely non-null
//      state is not enough. The scheduler flips `complete` + teardown
//      milliseconds before the engine writes the final projection, so a
//      non-null check quiesced the poll on the LAST PRE-COMPLETION snapshot,
//      freezing the board at N-1/N with a phantom in-progress task until a
//      cold restart. Requiring task-completeness on the state keeps polling
//      until the final projection write has actually been read.
//      Re-selecting an automation mode leaves `complete` and re-arms.
//   3. completion teardown already ran (`completionTeardownAt` set): teardown
//      runs inside the poll (`reconcileCompletedRunLifecycle`), and the auto-run
//      supervisor can flip runtimeState to `complete` before the poller ever ran
//      it, so stopping on (1)+(2) alone would strand the agent panels until a
//      later cold reopen. Deliberately NOT an agent-presence check: roster agent
//      records are recreated by every projection read, and a user may re-open a
//      role's panel after completion (board resume) — polling must not restart
//      for those, or the reconcile would tear the re-opened panel down.
// Empty-graph carve-out: a run with zero tasks has no per-task projection write
// to wait for, so once (1) and (3) hold a hydrated (non-null) empty state is
// already its final snapshot. `isCompletedSprintEngineRun` requires ≥1 task and
// would otherwise poll such a run forever.
export function canStopPollingCompletedSprintEngineProjection(
  workspace: Pick<Workspace, 'sprintEngineAutoState' | 'sprintEngineState'>,
): boolean {
  const state = workspace.sprintEngineState
  if (!state) return false
  const runtimeState = workspace.sprintEngineAutoState?.runtimeState
  // The shared terminal teardown (completion AND cancellation both run it) sets
  // this, so it is the third guard for either terminal path.
  const tornDown = workspace.sprintEngineAutoState?.completionTeardownAt !== undefined

  // Cancellation is the sibling terminal state. It reaches `canceled` via the
  // runtime broadcast, so this predicate is what stops the poll (a canceled run's
  // runtimeState is `canceled`, never `complete`, so the completion arm below
  // never matched it — the pre-fix bug that polled canceled runs forever).
  // Requires the hydrated state to ITSELF read canceled (parity with the
  // completion cold-restart guard): a stale pre-cancel snapshot keeps polling for
  // the one read that hydrates the canceled board and recolors its Backlog chip.
  if (runtimeState === 'canceled') {
    return isCanceledSprintEngineRun(state) && tornDown
  }

  if (runtimeState !== 'complete' || !tornDown) return false
  // A finished run with tasks must have read its final projection — task-
  // completeness on the hydrated state, not a mere non-null check (see the
  // header). An empty-graph run has no per-task projection write to wait for, so
  // a hydrated (non-null) empty state is already its final snapshot; without this
  // `isCompletedSprintEngineRun` (which requires ≥1 task) would poll it forever.
  return state.tasks.length === 0 || isCompletedSprintEngineRun(state)
}

function normalizedPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * The pull requests this run has, one per project it opened one for (MC-1612).
 *
 * A run spanning projects delivers one branch per project and therefore one pull
 * request per project, so the Backlog item carries one link each. `vcs.repos` is
 * always populated — a run stored before the list existed normalizes to a one-entry
 * primary — so this reads the list alone and single-repo runs come out as the one
 * unlabeled pull request they always were.
 */
function sprintEnginePullRequestsOf(
  state: SprintEngineState,
  workspaceRoot: string,
): { repoId: string; url: string; repoLabel?: string }[] {
  const repos = state.vcs?.repos ?? []
  const multiProject = repos.length > 1
  return repos.flatMap((repo) => {
    const url = repo.pullRequestUrl?.trim()
    if (!url) return []
    return [{
      repoId: repo.id,
      url,
      ...(multiProject ? { repoLabel: sprintEngineRepoDisplayName({ workspaceRoot, root: repo.root }) } : {}),
    }]
  })
}

async function refreshBacklogSprintEngineRunLinks(input: {
  workspace: Workspace
  state: SprintEngineState
  ports: SprintEngineProjectionRefreshPorts
}): Promise<void> {
  const { workspace, state, ports } = input
  // Both terminals refresh the run-link chip. Completion drives the item to
  // `completed`; cancellation only recolors the chip to `canceled` and never
  // drives the item status — a canceled sprint is a decision, not a finish, so
  // the Backlog item stays whatever the user left it (they may re-plan).
  const canceled = isCanceledSprintEngineRun(state)
  const completed = !canceled && isCompletedSprintEngineRun(state)
  if (!canceled && !completed) return
  const runLinkStatus = canceled ? 'canceled' : 'completed'
  if (!workspace.folderPath || !workspace.sprintEngineContext?.statePath) return
  if (!ports.readBacklogObjectStore || !ports.addOrUpdateBacklogLink) return

  const storeResult = await ports.readBacklogObjectStore(workspace.folderPath)
  if (!storeResult.ok) {
    await ports.publishDiagnostic?.({
      level: 'warning',
      source: 'sprintengine',
      title: 'Backlog link refresh failed',
      message: storeResult.message,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    return
  }

  const targetStatePathKey = normalizedPathKey(workspace.sprintEngineContext.statePath)
  const pullRequests = sprintEnginePullRequestsOf(state, workspace.folderPath)
  for (const record of storeResult.store.items) {
    // An epic carries the run's execution link too, but its lifecycle derives UP
    // from its children (see nextBacklogItemStatusFromLinks) — a finished run must
    // not complete the epic while children are still open (live incident
    // 2026-07-15). This store-only tick cannot see epic membership (frontmatter
    // `epic:`/`type:` are not persisted here), so it refreshes an epic's link chip
    // to Completed but never drives the epic's status; the epic-aware sync tick
    // owns epic completion.
    const isEpic = isBacklogEpicPath(record.source.relativePath)
    let matchedThisRun = false
    for (const link of record.links ?? []) {
      if (link.type !== 'execution') continue
      const linkStatePath = sprintEngineStatePathForBacklogLink(workspace.folderPath, link)
      if (!linkStatePath || normalizedPathKey(linkStatePath) !== targetStatePathKey) continue
      matchedThisRun = true
      // Nothing to reconcile once the chip already carries this run's terminal
      // status — and, for a completed run, the epic link (its only touch) or an
      // already-completed item is fully settled.
      if (link.status === runLinkStatus && (canceled || isEpic || record.status === 'completed')) continue

      const result = await ports.addOrUpdateBacklogLink({
        workspaceRoot: workspace.folderPath,
        relativePath: record.source.relativePath,
        link: { ...link, status: runLinkStatus },
        // Completion drives the item to `completed`; cancellation never drives
        // item status (see the entry comment). Epics and archived items keep
        // their own status derivation.
        status: canceled || isEpic || record.status === 'archived' ? undefined : 'completed',
      })
      if (!result.ok) {
        await ports.publishDiagnostic?.({
          level: 'warning',
          source: 'sprintengine',
          title: 'Backlog link refresh failed',
          message: result.message,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        })
      }
    }

    // Attach the completed sprint's pull requests to its originating item — one per
    // project it delivered (MC-1612). Only when this record links to the current run;
    // a project whose URL is already linked is skipped so the per-tick reconcile does
    // not churn the store. `external` is lifecycle-neutral, so no item-status change.
    if (!matchedThisRun) continue
    const existingByLinkId = new Map(
      sprintEnginePullRequestLinksOf(record.links ?? []).map((link) => [link.id, link.target.url]),
    )
    for (const pullRequest of pullRequests) {
      const link = buildSprintEnginePullRequestLink({
        pullRequestUrl: pullRequest.url,
        updatedAt: new Date(ports.now?.() ?? Date.now()).toISOString(),
        repoId: pullRequest.repoId,
        repoLabel: pullRequest.repoLabel,
      })
      if (existingByLinkId.get(link.id) === pullRequest.url) continue
      const prResult = await ports.addOrUpdateBacklogLink({
        workspaceRoot: workspace.folderPath,
        relativePath: record.source.relativePath,
        link,
      })
      if (!prResult.ok) {
        await ports.publishDiagnostic?.({
          level: 'warning',
          source: 'sprintengine',
          title: 'Backlog link refresh failed',
          message: prResult.message,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        })
      }
    }
  }
}
