/**
 * Renderer side of the main-process sprint scheduler bridge
 * (sprint-runtime-ownership Phase 2). Mounted once per window from
 * `WorkspaceManager`; mirrors `sprintengineAutomationModeSync`'s structure and
 * no-echo discipline.
 *
 * Three jobs:
 *
 * 1. **Run registration (renderer -> main)**: announce every sprint workspace
 *    (statePath + sprintEngineState) to the scheduler with its identity, run
 *    configuration, and persisted runtime residue. Re-registration is keyed on
 *    an identity+config SIGNATURE only — main adopts the runtime residue
 *    (agents, pendingSpawns, rosterSessions, delivered keys, teardown marker)
 *    on FIRST registration and owns it afterwards, so churn in those fields
 *    must never re-register (it would clobber main's newer view with our
 *    mirror of it). A statePath that disappears from the store unregisters.
 *
 * 2. **Runtime-op application (main -> renderer)**: apply
 *    `sprintengine:runtime-op` broadcasts into this window's store through the
 *    same store actions the sync bus uses, NEVER through paths that push back
 *    to main (every window receives the same broadcast; a bus dispatch or a
 *    stop-reason push would double-apply). Ops for a workspace that has not
 *    materialized yet are stashed per statePath and replayed in order by the
 *    store-change sweep.
 *
 * 3. **Dispose**: the returned function unsubscribes everything.
 */
import type { SprintRuntimeOp, SprintRuntimeRunRegistration } from '../../../shared/sprintengine/runtime-bridge'
import {
  agentCliSupportsConversationResume,
  agentCliUsesStableSessionIdForResume,
  resumeCapabilitiesForCli,
} from '../../../shared/agent-cli-resume'
import { useWorkspaceStore } from '../store/workspaceStore'
import { normalizeSprintEngineAutoState } from '../store/slices/runStateSlice'
import type { Workspace } from '../types/workspace'
import { applySprintEngineAutomationStopReason } from './sprintengineSupervisorNotifications'
import { tearDownDepartedTaskScopedWorker } from './sprintengineRunTeardown'

function findWorkspaceByStatePath(statePath: string): Workspace | undefined {
  return useWorkspaceStore.getState().workspaces
    .find((workspace) => workspace.sprintEngineContext?.statePath === statePath)
}

/** Sprint workspaces the scheduler should know about (same eligibility rule as the mode sync). */
function listRegistrableSprintWorkspaces(): Workspace[] {
  return useWorkspaceStore.getState().workspaces.filter((workspace) =>
    Boolean(workspace.sprintEngineContext?.statePath) && Boolean(workspace.sprintEngineState)
  )
}

function buildRegistration(workspace: Workspace, statePath: string): SprintRuntimeRunRegistration {
  const autoState = normalizeSprintEngineAutoState(workspace.sprintEngineAutoState)
  // The normalizer deliberately does not carry `architectGuidance` (it is a
  // creation-time value, not lifecycle state), so read it off the raw record.
  const architectGuidance =
    autoState.architectGuidance ?? workspace.sprintEngineAutoState?.architectGuidance
  return {
    statePath,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    folderPath: workspace.folderPath ?? '',
    memoryRelativeRoot: workspace.memory?.relativeRoot ?? null,
    cliPermissionPreset: autoState.cliPermissionPreset,
    maxConcurrentAgents: autoState.maxConcurrentAgents,
    ...(architectGuidance !== undefined ? { architectGuidance } : {}),
    pendingSpawns: autoState.pendingSpawns,
    deliveredAgentNotificationEventKeys: autoState.deliveredAgentNotificationEventKeys,
    ...(autoState.completionTeardownAt !== undefined
      ? { completionTeardownAt: autoState.completionTeardownAt }
      : {}),
    rosterSessions: workspace.sprintEngineRosterSessions ?? {},
    agents: workspace.agents,
  }
}

/**
 * Identity + run configuration only. Runtime residue (agents, pendingSpawns,
 * delivered keys, rosterSessions, completionTeardownAt) is adopted by main on
 * first registration and main-owned afterwards — it must NOT re-register.
 */
function registrationSignature(registration: SprintRuntimeRunRegistration): string {
  return JSON.stringify([
    registration.statePath,
    registration.workspaceId,
    registration.workspaceName,
    registration.folderPath,
    registration.memoryRelativeRoot,
    registration.cliPermissionPreset,
    registration.maxConcurrentAgents,
    registration.architectGuidance ?? null,
  ])
}

/** Apply one scheduler op to the local store. Store actions only — no sync-bus
 *  dispatch, no push back to main (the no-echo rule). */
function applyRuntimeOp(op: SprintRuntimeOp, workspaceId: string): void {
  const store = useWorkspaceStore.getState()
  switch (op.kind) {
    case 'agent_updated':
      store.updateAgent(workspaceId, op.agentId, op.update)
      return
    case 'assign_session': {
      // Resume capabilities are stamped from the local plugin catalog with the
      // same pure resolver main uses — the op carries only the cli id.
      const caps = resumeCapabilitiesForCli(op.cli, store.pluginCatalogEntries)
      store.applyAgentTerminalSessionEvent({
        workspaceId,
        agentId: op.agentId,
        sessionId: op.sessionId,
        cli: op.cli,
        cliResumeAvailable: agentCliSupportsConversationResume(caps),
        cliUsesStableSessionId: agentCliUsesStableSessionIdForResume(caps),
      })
      return
    }
    case 'launch_state':
      store.applyAgentTerminalLaunchStateEvent({
        workspaceId,
        agentId: op.agentId,
        ...op.update,
      })
      return
    case 'pending_spawns':
      store.setSprintEngineAutoPendingSpawns(workspaceId, op.pendingSpawns)
      return
    case 'notification_delivered':
      store.markSprintEngineAgentNotificationDelivered(workspaceId, op.eventKey)
      return
    case 'folder_missing':
      store.setFolderMissing(workspaceId, op.missing)
      return
    case 'stop_reason':
      // Same store transitions as a renderer-originated stop, but origin
      // 'main' suppresses the push back to the scheduler (it already knows).
      applySprintEngineAutomationStopReason(workspaceId, op.reason, op.context ?? {}, { origin: 'main' })
      return
    case 'roster_session_recorded':
      store.upsertSprintEngineRosterSession(workspaceId, op.agentId, op.session)
      return
    case 'worker_retired':
      // Renderer-side completion of a main-side retirement: record the
      // resumable session and remove the tab/agent record. Main already killed
      // the PTY; the teardown's kill/list calls swallow failures, so it is
      // safe against the already-dead session.
      void tearDownDepartedTaskScopedWorker(workspaceId, op.agentId).catch(() => undefined)
      return
    case 'completion_teardown_at':
      store.setSprintEngineCompletionTeardownAt(workspaceId, op.at)
      return
  }
}

/**
 * Start the registration sweep + runtime-op subscription. Returns a dispose
 * function. WorkspaceManager owns exactly one instance per window.
 */
export function initSprintEngineRuntimeBridge(): () => void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.registerSprintRuntimeRun || !api.onSprintRuntimeOp) return () => undefined

  // statePath -> last pushed identity/config signature.
  const registeredSignatures = new Map<string, string>()
  // Ops that arrived before their workspace materialized in this window
  // (projection still loading). Replayed in arrival order by the sweep.
  const pendingOpsByStatePath = new Map<string, SprintRuntimeOp[]>()

  const tryApplyOp = (op: SprintRuntimeOp): void => {
    const workspace = findWorkspaceByStatePath(op.statePath)
    if (!workspace) {
      const queue = pendingOpsByStatePath.get(op.statePath) ?? []
      queue.push(op)
      pendingOpsByStatePath.set(op.statePath, queue)
      return
    }
    applyRuntimeOp(op, workspace.id)
  }

  const unsubscribeOps = api.onSprintRuntimeOp((op) => tryApplyOp(op))

  const sweep = (): void => {
    // Replay stashed ops whose workspace has since materialized.
    for (const [statePath, queue] of [...pendingOpsByStatePath.entries()]) {
      const workspace = findWorkspaceByStatePath(statePath)
      if (!workspace) continue
      pendingOpsByStatePath.delete(statePath)
      for (const op of queue) applyRuntimeOp(op, workspace.id)
    }

    // Register new/changed runs; unregister removed ones.
    const seenStatePaths = new Set<string>()
    for (const workspace of listRegistrableSprintWorkspaces()) {
      const statePath = workspace.sprintEngineContext!.statePath
      seenStatePaths.add(statePath)
      const registration = buildRegistration(workspace, statePath)
      const signature = registrationSignature(registration)
      if (registeredSignatures.get(statePath) === signature) continue
      registeredSignatures.set(statePath, signature)
      void api.registerSprintRuntimeRun(registration).catch(() => {
        // Retry on the next store change; registration is an idempotent upsert.
        registeredSignatures.delete(statePath)
      })
    }
    for (const statePath of [...registeredSignatures.keys()]) {
      if (seenStatePaths.has(statePath)) continue
      registeredSignatures.delete(statePath)
      void api.unregisterSprintRuntimeRun?.({ statePath }).catch(() => undefined)
    }
  }

  sweep()
  const unsubscribeStore = useWorkspaceStore.subscribe(sweep)

  return () => {
    unsubscribeOps()
    unsubscribeStore()
  }
}
