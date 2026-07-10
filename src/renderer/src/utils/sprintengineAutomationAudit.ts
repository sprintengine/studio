import type {
  DiagnosticLevel,
  SprintEngineAutomationMode,
  SprintEngineAutomationRuntimeState,
} from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'
import {
  SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
  sprintEngineAutomationModeLabel,
} from './sprintengineNotifications'

function canPublishAutomationAudit(): boolean {
  return typeof window !== 'undefined' && Boolean(window.api?.logDiagnostic)
}

// The manual-mode transition audit moved to the main-process automation owner
// (`sprintengine-automation-service.ts`, MC-1567): every writer — UI, phone,
// future scheduler — audits through the one set-mode path, so the renderer no
// longer emits it. Runtime lifecycle transitions below are still renderer
// events (the loop is renderer-driven until the scheduler phase) and keep
// auditing here.

export function auditSprintEngineLifecycleTransition(input: {
  workspaceId: string
  workspaceName?: string
  desiredMode: SprintEngineAutomationMode
  previousRuntimeState?: SprintEngineAutomationRuntimeState
  nextRuntimeState: SprintEngineAutomationRuntimeState
  reason: string
  details?: string
  level?: DiagnosticLevel
  taskId?: string
  agentId?: string
}): void {
  if (!canPublishAutomationAudit()) return

  publishDiagnosticSync({
    level: input.level ?? 'info',
    source: 'sprintengine',
    title: SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE,
    message: `${input.nextRuntimeState}: ${input.reason}`,
    details: [
      `Mode: ${sprintEngineAutomationModeLabel(input.desiredMode)}`,
      input.previousRuntimeState ? `Previous state: ${input.previousRuntimeState}` : undefined,
      input.details,
    ].filter((line): line is string => Boolean(line)).join('\n'),
    workspaceId: input.workspaceId,
    ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.taskId ? { navigationTarget: { kind: 'task', ref: input.taskId } } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  })
}
