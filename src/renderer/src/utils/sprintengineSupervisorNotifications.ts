import { useWorkspaceStore } from '../store/workspaceStore'
import type { WorkspaceId } from '../types/workspace'
import { deriveSprintEngineAutomationMode } from './sprintengineAutomation'
import { sprintEngineAgentHasLiveRunWork } from './sprintengineAutomationLifecycle'
import { logPerfEvent } from './perfDiagnostics'

export type SprintEngineAutoRunDisableReason =
  | 'user_manual_toggle'
  | 'folder_missing'
  | 'blocked_on_external_input'
  | 'all_tasks_done'
  | 'workspace_removed'
  | 'agent_terminal_closed'
  | 'agent_spawn_failed'

const REASON_MESSAGES: Record<SprintEngineAutoRunDisableReason, string> = {
  user_manual_toggle: 'Switched to manual mode by the user.',
  folder_missing: 'Workspace folder is no longer available.',
  blocked_on_external_input: 'A task needs user input before agents can continue.',
  all_tasks_done: 'All tasks are complete.',
  workspace_removed: 'Workspace was removed.',
  agent_terminal_closed: 'An agent terminal was closed.',
  agent_spawn_failed: 'An agent terminal could not be started.',
}

// Compatibility mapper for older call sites that still report an auto-run stop
// reason. Runtime stops become lifecycle states; only the user Manual toggle
// changes the selected desired mode to Manual.
export function applySprintEngineAutomationStopReason(
  workspaceId: WorkspaceId,
  reason: SprintEngineAutoRunDisableReason,
  context: { taskId?: string; agentId?: string; message?: string; details?: string } = {},
): void {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === workspaceId)
  const mode = deriveSprintEngineAutomationMode(workspace?.sprintEngineAutoState)

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
  } else if (reason === 'all_tasks_done') {
    store.applySprintEngineAutomationEvent(workspaceId, {
      type: 'runner_complete',
      message: context.message ?? REASON_MESSAGES[reason],
    })
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
      && !sprintEngineAgentHasLiveRunWork(workspace?.sprintEngineState, workspace?.sprintEngineAutoState, context.agentId)
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
  } else {
    store.applySprintEngineAutomationEvent(workspaceId, {
      type: 'runner_failed',
      reason: reason === 'folder_missing' ? 'folder_missing' : 'spawn_failed',
      message: context.message ?? REASON_MESSAGES[reason],
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.agentId ? { agentId: context.agentId } : {}),
    })
  }
}
