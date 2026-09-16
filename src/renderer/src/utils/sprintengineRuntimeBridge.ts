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
 *    (agents, rosterSessions, delivered keys, teardown marker)
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
import type {
  SprintRuntimeAgentConfig,
  SprintRuntimeOp,
  SprintRuntimeRunRegistration,
} from '../../../shared/sprintengine/runtime-bridge'
import {
  agentCliSupportsConversationResume,
  agentCliUsesStableSessionIdForResume,
  resumeCapabilitiesForCli,
} from '../../../shared/agent-cli-resume'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useNotificationStore } from '../store/notificationStore'
import { normalizeSprintEngineAutoState } from '../store/slices/runStateSlice'
import { applyAgentTerminalRevealPolicy } from './modelRegistry'
import type { Workspace } from '../types/workspace'
import { applySprintEngineAutomationStopReason } from './sprintengineSupervisorNotifications'
import { isSprintEngineIpcBound, sprintEngineIpc } from '../modules/sprint-engine-ipc'
import {
  departedWorkerTeardownPortsWithoutRecord,
  tearDownDepartedTaskScopedWorker,
} from './sprintengineRunTeardown'
import { sprintEngineRunContext, sprintEngineRunState } from '../store/slices/workspaceModuleState'

function findWorkspaceByStatePath(statePath: string): Workspace | undefined {
  return useWorkspaceStore.getState().workspaces
    .find((workspace) => sprintEngineRunContext(workspace)?.statePath === statePath)
}

/** Sprint workspaces the scheduler should know about (same eligibility rule as the mode sync). */
function listRegistrableSprintWorkspaces(): Workspace[] {
  return useWorkspaceStore.getState().workspaces.filter((workspace) =>
    Boolean(sprintEngineRunContext(workspace)?.statePath) && Boolean(sprintEngineRunState(workspace))
  )
}

function buildRegistration(workspace: Workspace, statePath: string): SprintRuntimeRunRegistration {
  const autoState = normalizeSprintEngineAutoState(workspace.sprintEngineAutoState)
  return {
    statePath,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    folderPath: workspace.folderPath ?? '',
    memoryRelativeRoot: workspace.memory?.relativeRoot ?? null,
    cliPermissionPreset: autoState.cliPermissionPreset,
    maxConcurrentAgents: autoState.maxConcurrentAgents,
    deliveredAgentNotificationEventKeys: autoState.deliveredAgentNotificationEventKeys,
    ...(autoState.completionTeardownAt !== undefined
      ? { completionTeardownAt: autoState.completionTeardownAt }
      : {}),
    // Persisted lifecycle, adopted once with the residue: main preserves a
    // paused/blocked/failed/complete run through sidecar-mode adoption
    // instead of forcing it back to 'running' on relaunch.
    runtimeState: autoState.runtimeState,
    ...(autoState.reason !== undefined ? { reason: autoState.reason } : {}),
    ...(autoState.reasonMessage !== undefined ? { reasonMessage: autoState.reasonMessage } : {}),
    ...(autoState.reasonTaskId !== undefined ? { reasonTaskId: autoState.reasonTaskId } : {}),
    ...(autoState.reasonAgentId !== undefined ? { reasonAgentId: autoState.reasonAgentId } : {}),
    rosterSessions: workspace.sprintEngineRosterSessions ?? {},
    agents: workspace.agents,
    agentConfigs: buildAgentConfigs(workspace),
  }
}

/**
 * User-editable per-agent configuration main must honour on spawns: mid-run
 * runtime overrides (the board's per-agent CLI/model picker), renames, and
 * queued custom startup prompts. Renderer-owned, re-pushed on change.
 * `null` fields are explicit tombstones ("cleared"), and `configEditedAt`
 * carries the record's last-edit stamp so main's merge is last-write-wins —
 * a window whose store lags another window's edit re-registers with an older
 * stamp and is ignored rather than clobbering the edit.
 */
function buildAgentConfigs(workspace: Workspace): Record<string, SprintRuntimeAgentConfig> {
  const configs: Record<string, SprintRuntimeAgentConfig> = {}
  for (const [agentId, agent] of Object.entries(workspace.agents)) {
    if (agent.kind !== 'sprintengine') continue
    configs[agentId] = {
      cliRuntimeOverride: agent.cliRuntimeOverride ?? null,
      ...(agent.name ? { name: agent.name } : {}),
      cliStartupPrompt: agent.cliStartupPrompt ?? null,
      ...(agent.configEditedAt !== undefined ? { configEditedAt: agent.configEditedAt } : {}),
    }
  }
  return configs
}

/**
 * Identity + run configuration only. Runtime residue (agents, delivered keys,
 * rosterSessions, completionTeardownAt) is adopted by main on
 * first registration and main-owned afterwards — it must NOT re-register.
 * `agentConfigs` IS in the signature: user edits must reach main's spawns.
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
    registration.agentConfigs,
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
    case 'automation_resumed':
      // Main resumed a blocked run itself (a needs_input resolution lifted
      // the blocker): apply the same runner_started transition the board's
      // Resume control uses. Store action only — no push back to main.
      store.applySprintEngineAutomationEvent(workspaceId, { type: 'runner_started' })
      return
    case 'worker_retired':
      // Renderer-side completion of a main-side retirement: remove the
      // tab/agent record. Main already killed the PTY and RECORDED the roster
      // session (delivered as the preceding `roster_session_recorded` op), so
      // this applier must not re-record; the teardown's kill/list calls
      // swallow failures, so it is safe against the already-dead session.
      void tearDownDepartedTaskScopedWorker(
        workspaceId,
        op.agentId,
        departedWorkerTeardownPortsWithoutRecord(),
      ).catch(() => undefined)
      return
    case 'completion_teardown_at':
      store.setSprintEngineCompletionTeardownAt(workspaceId, op.at)
      return
    case 'diagnostic':
      // Main already wrote the JSONL — this window only surfaces the entry,
      // the notification half of the retired supervisor's publishDiagnostic.
      useNotificationStore.getState().addNotification(op.entry)
      return
    case 'reveal_policy':
      // Tab maintenance after a scheduler spawn/notification paste: rename an
      // OPEN tab to the current task label and re-stamp its config sessionId
      // (a stale one keeps the panel keyed to the killed previous session).
      // No-op when this window has no tab for the agent.
      applyAgentTerminalRevealPolicy(
        workspaceId,
        op.agentId,
        op.name,
        op.revealPolicy,
        op.sessionId ? { sessionId: op.sessionId } : undefined,
      )
      return
  }
}

/**
 * Start the registration sweep + runtime-op subscription. Returns a dispose
 * function. WorkspaceManager owns exactly one instance per window.
 */
export function initSprintEngineRuntimeBridge(): () => void {
  if (!isSprintEngineIpcBound()) return () => undefined

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

  const unsubscribeOps = sprintEngineIpc.onSprintRuntimeOp((op) => tryApplyOp(op))

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
      const statePath = sprintEngineRunContext(workspace)!.statePath
      seenStatePaths.add(statePath)
      const registration = buildRegistration(workspace, statePath)
      const signature = registrationSignature(registration)
      if (registeredSignatures.get(statePath) === signature) continue
      registeredSignatures.set(statePath, signature)
      void sprintEngineIpc.registerSprintRuntimeRun(registration).catch(() => {
        // Retry on the next store change; registration is an idempotent upsert.
        registeredSignatures.delete(statePath)
      })
    }
    for (const statePath of [...registeredSignatures.keys()]) {
      if (seenStatePaths.has(statePath)) continue
      registeredSignatures.delete(statePath)
      void sprintEngineIpc.unregisterSprintRuntimeRun({ statePath }).catch(() => undefined)
    }
  }

  sweep()
  const unsubscribeStore = useWorkspaceStore.subscribe(sweep)

  return () => {
    unsubscribeOps()
    unsubscribeStore()
  }
}
