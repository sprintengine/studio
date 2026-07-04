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
import { isCompletedSprintEngineRun, normalizeSprintEngineProjection } from './sprintengine'
import {
  buildSprintEnginePullRequestLink,
  sprintEngineStatePathForBacklogLink,
  SPRINT_ENGINE_PR_LINK_ID,
} from './sprintengineBacklogLinks'
import { tearDownCompletedSprintRunAgents } from './sprintengineRunTeardown'

export type SprintEngineProjectionRefreshCause = 'supervisor' | 'auto-run' | 'manual' | 'mutation'

export type SprintEngineProjectionRefreshResult =
  | { status: 'changed'; state: SprintEngineState }
  | { status: 'unchanged'; state: SprintEngineState | null }
  | { status: 'skipped'; reason: 'missing-context' }
  | { status: 'error'; message: string }

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
    if (!projectionResult.ok) throw new Error(projectionResult.message)

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
    await ports.publishDiagnostic?.({
      level: 'warning',
      source: 'sprintengine',
      title: 'Sprint projection refresh failed',
      message,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    logPerfEvent('SprintEngineProjection', 'refresh-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      message,
      elapsedMs: Math.round((ports.now?.() ?? performance.now()) - startedAt),
    })
    return { status: 'error', message }
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
  // retries on the next entry; it owns completion teardown for every automation
  // mode, including a run reopened after the app restarted.
  if (workspace.sprintEngineAutoState?.completionTeardownAt === undefined) {
    void (async () => {
      await ports.tearDownCompletedRunAgents?.(workspace.id)
      ports.setCompletionTeardownAt?.(workspace.id, ports.now?.() ?? Date.now())
    })().catch(() => {
      // Leave the marker unset so the next entry retries the teardown.
    })
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
// A finished run is terminal — its projection won't change again — but three
// conditions must all hold before we skip it:
//   1. lifecycle `complete` (not raw task-completeness): a run that finished but
//      is still stuck in `paused` must keep polling so `reconcileCompletedRun-
//      Lifecycle` can self-heal it to `complete` first; the next tick skips it.
//   2. `sprintEngineState` already hydrated: the projection is intentionally not
//      persisted across sessions (`normalizeWorkspaceForPartialize` nulls it to
//      avoid a localStorage write-storm), so a cold `complete` run after an app
//      restart still needs one read to populate the board and run summary.
//      Skipping before that read strands the board on "workspace data is
//      missing". Re-selecting an automation mode leaves `complete` and re-arms.
//   3. completion teardown already ran (`completionTeardownAt` set): teardown
//      runs inside the poll (`reconcileCompletedRunLifecycle`), and the auto-run
//      supervisor can flip runtimeState to `complete` before the poller ever ran
//      it, so stopping on (1)+(2) alone would strand the agent panels until a
//      later cold reopen. Deliberately NOT an agent-presence check: roster agent
//      records are recreated by every projection read, and a user may re-open a
//      role's panel after completion (board resume) — polling must not restart
//      for those, or the reconcile would tear the re-opened panel down.
export function canStopPollingCompletedSprintEngineProjection(
  workspace: Pick<Workspace, 'sprintEngineAutoState' | 'sprintEngineState'>,
): boolean {
  return workspace.sprintEngineAutoState?.runtimeState === 'complete'
    && Boolean(workspace.sprintEngineState)
    && workspace.sprintEngineAutoState?.completionTeardownAt !== undefined
}

function normalizedPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

async function refreshBacklogSprintEngineRunLinks(input: {
  workspace: Workspace
  state: SprintEngineState
  ports: SprintEngineProjectionRefreshPorts
}): Promise<void> {
  const { workspace, state, ports } = input
  if (!isCompletedSprintEngineRun(state)) return
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
  const pullRequestUrl = state.vcs?.pullRequestUrl?.trim() || null
  for (const record of storeResult.store.items) {
    let matchedThisRun = false
    for (const link of record.links ?? []) {
      if (link.type !== 'execution') continue
      const linkStatePath = sprintEngineStatePathForBacklogLink(workspace.folderPath, link)
      if (!linkStatePath || normalizedPathKey(linkStatePath) !== targetStatePathKey) continue
      matchedThisRun = true
      if (link.status === 'completed' && record.status === 'completed') continue

      const result = await ports.addOrUpdateBacklogLink({
        workspaceRoot: workspace.folderPath,
        relativePath: record.source.relativePath,
        link: { ...link, status: 'completed' },
        status: record.status === 'archived' ? undefined : 'completed',
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

    // Attach the completed sprint's pull request to its originating item. Only
    // when this record links to the current run and a PR exists; skipped when
    // the same URL is already linked so the per-tick reconcile does not churn
    // the store. `external` is lifecycle-neutral, so no item-status change.
    if (matchedThisRun && pullRequestUrl) {
      const existingPr = (record.links ?? []).find((link) => link.id === SPRINT_ENGINE_PR_LINK_ID)
      if (existingPr?.target.url !== pullRequestUrl) {
        const now = new Date(ports.now?.() ?? Date.now()).toISOString()
        const prResult = await ports.addOrUpdateBacklogLink({
          workspaceRoot: workspace.folderPath,
          relativePath: record.source.relativePath,
          link: buildSprintEnginePullRequestLink({ pullRequestUrl, updatedAt: now }),
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
}
