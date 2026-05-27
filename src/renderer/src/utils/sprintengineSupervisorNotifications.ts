import { useWorkspaceStore } from '../store/workspaceStore'
import type { WorkspaceId } from '../types/workspace'
import { publishDiagnostic } from './diagnostics'
import { deriveSprintEngineAutomationMode } from './sprintengineAutomation'

export type SprintEngineAutoRunDisableReason =
  | 'user_manual_toggle'
  | 'folder_missing'
  | 'blocked_on_external_input'
  | 'all_tasks_done'
  | 'workspace_removed'
  | 'agent_terminal_closed'

const REASON_MESSAGES: Record<SprintEngineAutoRunDisableReason, string> = {
  user_manual_toggle: 'Switched to manual mode by the user.',
  folder_missing: 'Workspace folder is no longer available.',
  blocked_on_external_input: 'A task needs input from the user or architect before agents can continue.',
  all_tasks_done: 'All tasks are complete.',
  workspace_removed: 'Workspace was removed.',
  agent_terminal_closed: 'An agent terminal was closed.',
}

// Centralized off-switch for the Sprint Engine AutoRun supervisor. Routes
// every off-transition through one place so the user always gets a
// notification explaining when and why automation stopped. Callers must
// supply a reason; the slice action stays available for rollbacks and other
// internal transitions that shouldn't surface a notification.
export function disableSprintEngineAutoRun(
  workspaceId: WorkspaceId,
  reason: SprintEngineAutoRunDisableReason,
  context: { taskId?: string; agentId?: string } = {},
): void {
  const store = useWorkspaceStore.getState()
  const workspace = store.workspaces.find((ws) => ws.id === workspaceId)
  const wasActive = deriveSprintEngineAutomationMode(workspace?.sprintEngineAutoState) !== 'manual'
  store.setSprintEngineAutomationMode(workspaceId, 'manual')
  if (!wasActive) return

  publishDiagnostic({
    level: reason === 'folder_missing' ? 'error' : 'info',
    source: 'sprintengine',
    title: 'AutoRun supervisor switched off',
    message: REASON_MESSAGES[reason],
    workspaceId,
    ...(workspace?.name ? { workspaceName: workspace.name } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.agentId ? { agentId: context.agentId } : {}),
  })
}
