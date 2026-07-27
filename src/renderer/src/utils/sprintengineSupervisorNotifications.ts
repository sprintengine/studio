import { useWorkspaceStore } from '../store/workspaceStore'
import type { WorkspaceId } from '../types/workspace'
import { deriveSprintEngineAutomationMode } from './sprintengineAutomation'
import { sprintEngineAgentHasLiveRunWork } from './sprintengineAutomationLifecycle'
import { logPerfEvent } from './perfDiagnostics'
// Canonical union lives with the shared executor ports (the main process
// drives the same auto-run cycle); re-exported here so existing import sites
// and the store-bound stop path below can never drift from the port type.
import type { SprintEngineAutoRunDisableReason } from '../../../shared/sprintengine/auto-run-executor'

export type { SprintEngineAutoRunDisableReason } from '../../../shared/sprintengine/auto-run-executor'

// The audit sentence for a user-driven switch to Manual. Exported because the
// Sprints door writes that intent by statePath rather than through this
// workspace-keyed path (MC-1799), and both must record the same reason.
export const SPRINT_ENGINE_MANUAL_MODE_REASON = 'Switched to manual mode by the user.'

const REASON_MESSAGES: Record<SprintEngineAutoRunDisableReason, string> = {
  user_manual_toggle: SPRINT_ENGINE_MANUAL_MODE_REASON,
  folder_missing: 'Workspace folder is no longer available.',
  blocked_on_external_input: 'A task needs user input before agents can continue.',
  all_tasks_done: 'All tasks are complete.',
  workspace_removed: 'Workspace was removed.',
  agent_terminal_closed: 'An agent terminal was closed.',
  agent_spawn_failed: 'An agent terminal could not be started.',
}

// Fire-and-forget mirror of a renderer-originated stop into the main-process
// sprint scheduler (sprint-runtime-ownership Phase 2), so it pauses in step
// with the UI. Never called for main-originated stops (origin 'main': the
// scheduler already applied it — echoing would re-apply) nor for
// 'user_manual_toggle' (that intent reaches main through the Phase 1
// automation-mode push).
function pushStopReasonToSprintRuntime(
  statePath: string | undefined,
  reason: Exclude<SprintEngineAutoRunDisableReason, 'user_manual_toggle'>,
  context: { taskId?: string; agentId?: string; message?: string; details?: string },
): void {
  if (!statePath) return
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api?.pushSprintRuntimeStopReason) return
  void api.pushSprintRuntimeStopReason({ statePath, reason, context }).catch(() => undefined)
}

// Compatibility mapper for older call sites that still report an auto-run stop
// reason. Runtime stops become lifecycle states; only the user Manual toggle
// changes the selected desired mode to Manual. Renderer-originated stops
// (the default origin) are also pushed to the main-process scheduler.
export function applySprintEngineAutomationStopReason(
  workspaceId: WorkspaceId,
  reason: SprintEngineAutoRunDisableReason,
  context: { taskId?: string; agentId?: string; message?: string; details?: string } = {},
  options: { origin?: 'renderer' | 'main' } = {},
): void {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === workspaceId)
  const mode = deriveSprintEngineAutomationMode(workspace?.sprintEngineAutoState)
  const origin = options.origin ?? 'renderer'
  const notifyMainScheduler = (): void => {
    if (origin !== 'renderer' || reason === 'user_manual_toggle') return
    pushStopReasonToSprintRuntime(workspace?.sprintEngineContext?.statePath, reason, context)
  }

  if (reason === 'user_manual_toggle') {
    store.setSprintEngineAutomationMode(workspaceId, 'manual', {
      reason: context.message ?? REASON_MESSAGES[reason],
      ...(context.details ? { details: context.details } : {}),
    })
    return
  }

  if (mode === 'manual') return

  if (reason === 'blocked_on_external_input') {
    store.applySprintEngineAutomationEvent(workspaceId, {
      type: 'runner_blocked',
      message: context.message ?? REASON_MESSAGES[reason],
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.agentId ? { agentId: context.agentId } : {}),
    })
    notifyMainScheduler()
  } else if (reason === 'all_tasks_done') {
    store.applySprintEngineAutomationEvent(workspaceId, {
      type: 'runner_complete',
      message: context.message ?? REASON_MESSAGES[reason],
    })
    notifyMainScheduler()
  } else if (reason === 'agent_terminal_closed' || reason === 'workspace_removed') {
    // MC-1450 (Phase 1b): under MC-1444's one-session-per-task model, agent
    // terminals and tabs are torn down routinely — and programmatic roster-tab
    // removal reaches the same close handlers as a user click, so this reason
    // used to pause a healthy mid-flight run with no self-heal short of manual
    // Resume. Only treat the close as an intervention when the agent actually
    // holds live run work; a workless close stays lifecycle-neutral.
    // `workspace_removed` is unconditional — removing the workspace IS intent.
    if (
      reason === 'agent_terminal_closed'
      && !sprintEngineAgentHasLiveRunWork(workspace?.sprintEngineState, context.agentId)
    ) {
      logPerfEvent('SprintEngineAutoRun', 'terminal-close-ignored-no-live-work', {
        workspaceId,
        agentId: context.agentId ?? null,
      })
      return
    }
    store.applySprintEngineAutomationEvent(workspaceId, {
      type: 'runner_paused',
      reason: reason === 'agent_terminal_closed' ? 'terminal_closed' : 'workspace_removed',
      message: context.message ?? REASON_MESSAGES[reason],
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.agentId ? { agentId: context.agentId } : {}),
    })
    notifyMainScheduler()
  } else {
    store.applySprintEngineAutomationEvent(workspaceId, {
      type: 'runner_failed',
      reason: reason === 'folder_missing' ? 'folder_missing' : 'spawn_failed',
      message: context.message ?? REASON_MESSAGES[reason],
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.agentId ? { agentId: context.agentId } : {}),
    })
    notifyMainScheduler()
  }
}
