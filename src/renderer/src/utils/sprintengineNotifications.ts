import type {
  AppNotification,
  DiagnosticLevel,
  SprintEngineAutomationMode,
  WorkspaceId,
} from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'

// Title + mode labels live in the shared automation vocabulary (MC-1567) so
// the main-process audit writer emits byte-identical records; re-exported here
// to keep existing renderer import sites working.
export {
  SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
  sprintEngineAutomationModeLabel,
} from '../../../shared/sprintengine/automation-types'
import {
  SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
  sprintEngineAutomationModeLabel,
} from '../../../shared/sprintengine/automation-types'

export function isSprintEngineAutomationNotification(notification: AppNotification): boolean {
  return notification.source === 'sprintengine'
    && notification.title === SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE
}

export function countUnreadSprintEngineAutomationNotifications(
  notifications: AppNotification[],
  workspaceId: WorkspaceId,
): number {
  return notifications.filter((notification) =>
    !notification.read
    && notification.workspaceId === workspaceId
    && isSprintEngineAutomationNotification(notification)
  ).length
}

export function publishSprintEngineAutomationModeNotification(input: {
  workspaceId: WorkspaceId
  workspaceName?: string
  mode: SprintEngineAutomationMode
  reason?: string
  details?: string
  level?: DiagnosticLevel
  taskId?: string
  agentId?: string
}): void {
  const modeLabel = sprintEngineAutomationModeLabel(input.mode)
  publishDiagnosticSync({
    level: input.level ?? 'info',
    source: 'sprintengine',
    title: SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
    message: input.reason ? `${modeLabel}: ${input.reason}` : `Sprint automation is now ${modeLabel}.`,
    ...(input.details ? { details: input.details } : {}),
    workspaceId: input.workspaceId,
    ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.taskId ? { navigationTarget: { kind: 'task', ref: input.taskId } } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  })
}
