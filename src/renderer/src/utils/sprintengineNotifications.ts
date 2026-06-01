import type {
  AppNotification,
  DiagnosticLevel,
  SprintEngineAutomationMode,
  WorkspaceId,
} from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'
import { sprintEngineAutomationModeOptions } from './sprintengineAutomation'

export const SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE = 'Auto-run mode changed'

export function sprintEngineAutomationModeLabel(mode: SprintEngineAutomationMode): string {
  return sprintEngineAutomationModeOptions.find((option) => option.value === mode)?.label ?? mode
}

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

// The run's Activity feed: every Sprint Engine notification scoped to this
// workspace, newest first (the store already unshifts new entries). This is the
// single source of truth the Activity tab renders AND the source of its unread
// count — the two must never diverge, which was the original defect: a count on
// the settings gear that led to a list living somewhere else.
export function getSprintEngineRunActivity(
  notifications: AppNotification[],
  workspaceId: WorkspaceId,
): AppNotification[] {
  return notifications.filter(
    (notification) =>
      notification.source === 'sprintengine' && notification.workspaceId === workspaceId,
  )
}

export function countUnreadSprintEngineRunActivity(
  notifications: AppNotification[],
  workspaceId: WorkspaceId,
): number {
  return getSprintEngineRunActivity(notifications, workspaceId).filter(
    (notification) => !notification.read,
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
    message: input.reason ? `${modeLabel}: ${input.reason}` : `Sprint Engine automation is now ${modeLabel}.`,
    ...(input.details ? { details: input.details } : {}),
    workspaceId: input.workspaceId,
    ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  })
}
