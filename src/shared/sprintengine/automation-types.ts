/**
 * Sprint Engine automation types shared across main, preload, and renderer.
 *
 * Relocated from `src/renderer/src/types/workspace.ts` (which re-exports them
 * for existing renderer import sites) so the main-process automation owner and
 * the mobile bridge can speak the same vocabulary without importing renderer
 * modules. Everything here is data-shape only — no runtime dependencies.
 */

export type {
  CliPermissionPreset as SprintEngineCliPermissionPreset,
  LegacyCliPermissionPreset,
} from '../cli-permission-preset'
import type { CliPermissionPreset } from '../cli-permission-preset'
export type SprintEngineAutomationMode = 'manual' | 'run_agents' | 'run_agents_and_approve_artifacts'
export type SprintEngineAutomationDesiredMode = SprintEngineAutomationMode
export type SprintEngineAutomationRuntimeState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'failed'
  | 'complete'
  // Terminal like `complete`, but a user decision to stop the run rather than a
  // finished task graph (MC-1604). Nothing auto-resumes it; only explicit user
  // intent (re-selecting a mode) leaves it.
  | 'canceled'

export type SprintEngineAutomationStopReason =
  | 'user_selected_manual'
  | 'folder_missing'
  | 'spawn_failed'
  | 'blocked_on_input'
  | 'all_tasks_done'
  // The run was canceled by the user (MC-1604): the terminal reason paired with
  // the `canceled` runtime state, mirroring `all_tasks_done` for `complete`.
  | 'run_canceled'
  | 'terminal_closed'
  | 'workspace_removed'
  | 'startup'

export type SprintEngineAutomationEvent =
  | { type: 'user_set_mode'; mode: SprintEngineAutomationDesiredMode }
  | { type: 'runner_started' }
  | {
    type: 'runner_paused'
    reason: SprintEngineAutomationStopReason
    message?: string
    taskId?: string
    agentId?: string
  }
  | { type: 'runner_blocked'; message: string; taskId?: string; agentId?: string }
  | {
    type: 'runner_failed'
    reason: SprintEngineAutomationStopReason
    message: string
    taskId?: string
    agentId?: string
  }
  | { type: 'runner_complete'; message?: string }
  | { type: 'runner_canceled'; message?: string }

export type SprintEngineAutoState = {
  desiredMode?: SprintEngineAutomationDesiredMode
  runtimeState?: SprintEngineAutomationRuntimeState
  reason?: SprintEngineAutomationStopReason
  reasonMessage?: string
  reasonTaskId?: string
  reasonAgentId?: string
  changedAt?: number
  cliPermissionPreset: CliPermissionPreset
  maxConcurrentAgents: number
  deliveredAgentNotificationEventKeys: string[]
  // One-shot completion-teardown marker: set (to the teardown timestamp) after
  // `tearDownCompletedSprintRunAgents` finished for the current completion, so
  // the projection reconcile never re-fires teardown against panels the user
  // re-opened afterwards (board resume, recovery audit, manual spawn). Cleared
  // by the reconcile when the run's tasks are no longer all done (scope
  // expansion / a chained follow-up sprint), re-arming teardown for the next
  // completion. Persisted with the rest of the auto state.
  completionTeardownAt?: number
}

/**
 * The one user-facing label per mode. Shared so the main-process audit and the
 * renderer UI can never drift apart; the renderer's richer option list (with
 * hints) builds its labels from this.
 */
export function sprintEngineAutomationModeLabel(mode: SprintEngineAutomationMode): string {
  switch (mode) {
    case 'manual':
      return 'Manual'
    case 'run_agents':
      return 'Run agents'
    case 'run_agents_and_approve_artifacts':
      return 'Run agents + approve artifacts'
  }
}

/** Diagnostics/notification title shared by every automation-mode audit writer. */
export const SPRINT_ENGINE_AUTOMATION_NOTIFICATION_TITLE = 'Auto-run mode changed'
