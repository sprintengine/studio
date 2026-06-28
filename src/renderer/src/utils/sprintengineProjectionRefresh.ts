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
import { normalizeSprintEngineProjection } from './sprintengine'
import {
  buildSprintEnginePullRequestLink,
  sprintEngineStatePathForBacklogLink,
  SPRINT_ENGINE_PR_LINK_ID,
} from './sprintengineBacklogLinks'

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
      // already-parsed stored state on every tick instead.
      reconcileCompletedRunLifecycle(workspace, workspace.sprintEngineState, ports)
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
    reconcileCompletedRunLifecycle(workspace, parsedState, ports)
    await refreshBacklogSprintEngineRunLinks({
      workspace,
      state: parsedState,
      ports,
    })
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

// Bring the automation lifecycle in line with a run whose tasks are all done.
// Task-completeness (not the raw projection `run.status`) is the canonical
// "run finished" signal used by the auto-run supervisor and Backlog links, and
// it is the only completion signal available on the parsed state for unchanged
// polls. Re-firing on an already-`complete` run is a no-op in the reducer, so
// the runtime-state gate keeps us from churning the store on every poll.
function reconcileCompletedRunLifecycle(
  workspace: Workspace,
  state: SprintEngineState | null,
  ports: SprintEngineProjectionRefreshPorts,
): void {
  if (!state || !isCompletedSprintEngineRun(state)) return
  if (workspace.sprintEngineAutoState?.runtimeState === 'complete') return
  ports.applySprintEngineAutomationEvent?.(workspace.id, {
    type: 'runner_complete',
    message: 'All tasks are complete.',
  })
}

// Whether the projection poller can stop reading a workspace's projection.json.
// A finished run is terminal — its projection won't change again — but two
// conditions must both hold before we skip it:
//   1. lifecycle `complete` (not raw task-completeness): a run that finished but
//      is still stuck in `paused` must keep polling so `reconcileCompletedRun-
//      Lifecycle` can self-heal it to `complete` first; the next tick skips it.
//   2. `sprintEngineState` already hydrated: the projection is intentionally not
//      persisted across sessions (`normalizeWorkspaceForPartialize` nulls it to
//      avoid a localStorage write-storm), so a cold `complete` run after an app
//      restart still needs one read to populate the board and run summary.
//      Skipping before that read strands the board on "workspace data is
//      missing". Re-selecting an automation mode leaves `complete` and re-arms.
export function canStopPollingCompletedSprintEngineProjection(
  workspace: Pick<Workspace, 'sprintEngineAutoState' | 'sprintEngineState'>,
): boolean {
  return workspace.sprintEngineAutoState?.runtimeState === 'complete'
    && Boolean(workspace.sprintEngineState)
}

function normalizedPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

// Canonical "this run is finished" signal: every task is done. This is the same
// signal the auto-run supervisor's hard completion gate uses, so a completed run
// can never auto-spawn — see SprintEngineAutoRunSupervisor.superviseWorkspace.
export function isCompletedSprintEngineRun(state: SprintEngineState): boolean {
  return state.tasks.length > 0 && state.tasks.every((task) => task.status === 'done')
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
