/**
 * Sprint Engine automation lifecycle — the pure state machine.
 *
 * Relocated from `src/renderer/src/utils/sprintengineAutomationLifecycle.ts`
 * (which re-exports everything here for existing renderer import sites) so the
 * main-process automation owner runs the exact same transitions as the
 * renderer. Pure with respect to side effects: no window, no electron, no
 * store — `now` is injectable and defaults to the wall clock.
 *
 * Helpers that read renderer-only shapes (`Workspace`, `SprintEngineState`)
 * deliberately stay in the renderer shim.
 */
import type {
  LegacyCliPermissionPreset,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  SprintEngineAutomationDesiredMode,
  SprintEngineAutomationEvent,
  SprintEngineAutomationMode,
  SprintEngineAutomationRuntimeState,
  SprintEngineAutomationStopReason,
} from './automation-types'

const desiredModes = new Set<SprintEngineAutomationDesiredMode>([
  'manual',
  'run_agents',
  'run_agents_and_approve_artifacts',
])

const runtimeStates = new Set<SprintEngineAutomationRuntimeState>([
  'idle',
  'running',
  'paused',
  'blocked',
  'failed',
  'complete',
  'canceled',
])

const stopReasons = new Set<SprintEngineAutomationStopReason>([
  'user_selected_manual',
  'folder_missing',
  'spawn_failed',
  'blocked_on_input',
  'all_tasks_done',
  'run_canceled',
  'terminal_closed',
  'workspace_removed',
  'startup',
])

// The terminal runtime states: once reached, only explicit user intent
// (re-selecting a mode) may leave them. `canceled` joins `complete` here so the
// async terminal-close events from its own teardown cannot demote it back to
// `paused` (see the guard below).
const terminalRuntimeStates = new Set<SprintEngineAutomationRuntimeState>([
  'complete',
  'canceled',
])

export function isSprintEngineAutomationMode(input: unknown): input is SprintEngineAutomationMode {
  return typeof input === 'string' && desiredModes.has(input as SprintEngineAutomationDesiredMode)
}

function isDesiredMode(input: unknown): input is SprintEngineAutomationDesiredMode {
  return isSprintEngineAutomationMode(input)
}

function isRuntimeState(input: unknown): input is SprintEngineAutomationRuntimeState {
  return typeof input === 'string' && runtimeStates.has(input as SprintEngineAutomationRuntimeState)
}

function isStopReason(input: unknown): input is SprintEngineAutomationStopReason {
  return typeof input === 'string' && stopReasons.has(input as SprintEngineAutomationStopReason)
}

export function deriveSprintEngineAutomationDesiredMode(
  autoState: Partial<SprintEngineAutoState> | null | undefined,
): SprintEngineAutomationDesiredMode {
  if (isDesiredMode(autoState?.desiredMode)) return autoState.desiredMode
  return 'manual'
}

export function normalizeSprintEngineAutomationRuntimeState(
  input: unknown,
  desiredMode: SprintEngineAutomationDesiredMode,
): SprintEngineAutomationRuntimeState {
  if (isRuntimeState(input)) return input
  return desiredMode === 'manual' ? 'idle' : 'running'
}

export function normalizeSprintEngineAutomationStopReason(
  input: unknown,
): SprintEngineAutomationStopReason | undefined {
  return isStopReason(input) ? input : undefined
}

export function sprintEngineAutomationShouldRun(
  autoState: Partial<SprintEngineAutoState> | null | undefined,
): boolean {
  const desiredMode = deriveSprintEngineAutomationDesiredMode(autoState)
  const runtimeState = normalizeSprintEngineAutomationRuntimeState(autoState?.runtimeState, desiredMode)
  return desiredMode !== 'manual' && runtimeState === 'running'
}

export function sprintEngineAutomationModeForRunOptions(input: {
  startRunner: boolean
  autoApproveArtifacts: boolean
}): SprintEngineAutomationDesiredMode {
  if (input.autoApproveArtifacts) return 'run_agents_and_approve_artifacts'
  return input.startRunner ? 'run_agents' : 'manual'
}

export function sprintEngineAutomationInitialStateForMode(
  mode: SprintEngineAutomationDesiredMode,
  now = Date.now(),
): Pick<
  SprintEngineAutoState,
  | 'desiredMode'
  | 'runtimeState'
  | 'reason'
  | 'reasonMessage'
  | 'reasonTaskId'
  | 'reasonAgentId'
  | 'changedAt'
> {
  const enabled = mode !== 'manual'
  return {
    desiredMode: mode,
    runtimeState: enabled ? 'running' : 'idle',
    reason: undefined,
    reasonMessage: undefined,
    reasonTaskId: undefined,
    reasonAgentId: undefined,
    changedAt: now,
  }
}

export function transitionSprintEngineAutomation(
  current: SprintEngineAutoState,
  event: SprintEngineAutomationEvent,
  now = Date.now(),
): SprintEngineAutoState {
  const desiredMode = deriveSprintEngineAutomationDesiredMode(current)
  const runtimeState = normalizeSprintEngineAutomationRuntimeState(current.runtimeState, desiredMode)

  const base: SprintEngineAutoState = {
    ...current,
    desiredMode,
    runtimeState,
  }

  // `complete` and `canceled` are terminal runtime states. Reaching either tears
  // the run's agent panels down (see `tearDownCompletedSprintRunAgents` / the
  // cancel teardown), and those terminal-close events arrive asynchronously —
  // after the terminal transition — as `runner_paused{ reason: terminal_closed }`.
  // Without this guard they would demote a finished/canceled run back to `paused`
  // (the "An agent terminal was closed" pill). Only explicit user intent
  // (re-selecting an automation mode) leaves a terminal state.
  if (terminalRuntimeStates.has(runtimeState) && event.type !== 'user_set_mode') {
    return base
  }

  const clearReason = {
    reason: undefined,
    reasonMessage: undefined,
    reasonTaskId: undefined,
    reasonAgentId: undefined,
  }

  switch (event.type) {
    case 'user_set_mode': {
      const enabled = event.mode !== 'manual'
      return {
        ...base,
        desiredMode: event.mode,
        runtimeState: enabled ? 'running' : 'idle',
        reason: enabled ? undefined : 'user_selected_manual',
        reasonMessage: enabled ? undefined : 'Switched to manual mode by the user.',
        reasonTaskId: undefined,
        reasonAgentId: undefined,
        changedAt: now,
      }
    }

    case 'runner_started':
      return {
        ...base,
        ...clearReason,
        runtimeState: base.desiredMode === 'manual' ? 'idle' : 'running',
        changedAt: now,
      }

    case 'runner_paused':
      return {
        ...base,
        runtimeState: 'paused',
        reason: event.reason,
        reasonMessage: event.message,
        reasonTaskId: event.taskId,
        reasonAgentId: event.agentId,
        changedAt: now,
      }

    case 'runner_blocked':
      return {
        ...base,
        runtimeState: 'blocked',
        reason: 'blocked_on_input',
        reasonMessage: event.message,
        reasonTaskId: event.taskId,
        reasonAgentId: event.agentId,
        changedAt: now,
      }

    case 'runner_failed':
      return {
        ...base,
        runtimeState: 'failed',
        reason: event.reason,
        reasonMessage: event.message,
        reasonTaskId: event.taskId,
        reasonAgentId: event.agentId,
        changedAt: now,
      }

    case 'runner_complete':
      return {
        ...base,
        runtimeState: 'complete',
        reason: 'all_tasks_done',
        reasonMessage: event.message ?? 'All tasks are complete.',
        reasonTaskId: undefined,
        reasonAgentId: undefined,
        changedAt: now,
      }

    case 'runner_canceled':
      return {
        ...base,
        runtimeState: 'canceled',
        reason: 'run_canceled',
        reasonMessage: event.message ?? 'The run was canceled.',
        reasonTaskId: undefined,
        reasonAgentId: undefined,
        changedAt: now,
      }
  }
}

/**
 * Bridge from the three-state automation mode to the two-state headless-CLI
 * polling flag. Manual = headless `join --watch` exits when idle; any
 * automation mode = headless `join --watch` keeps polling. The Multicode
 * supervisor itself does not consult this value, but the one authoritative
 * set-mode path writes it so a headless CLI agent opened against the same run
 * respects the user's intent.
 */
export function sprintEngineCliWatchPollingForAutomationMode(
  mode: SprintEngineAutomationMode,
): 'enabled' | 'disabled' {
  return mode === 'manual' ? 'disabled' : 'enabled'
}

/**
 * The permission preset a spawn actually runs on, and the ONLY place the
 * pre-MC-2210 spellings are understood. Relocated with MC-2160 because main
 * normalizes it when it composes a sprint run; `settingsSlice.ts` re-exports it.
 *
 * Legacy `default` maps to `manual`, NOT to `none`, even though `none` is what
 * reproduces its exact argv. Two reasons, both found the hard way:
 *
 *  1. `default` was doing double duty — a real preset AND the "this run has no
 *     local override" sentinel that persistence and run settings test against.
 *     Mapping it to `none` makes it a third real value and the sentinel stops
 *     matching, so a factory-default run silently stops inheriting the app
 *     default (caught by the v61 persistence migration test).
 *  2. It is the conservative direction. `none` sends no flag, and no flag now
 *     means whatever the CLI defaults to — auto mode on Claude Code 2.1.228+
 *     with a Pro/Max/Team plan. `manual` is the value that still means what
 *     the old preset's label promised: ask before every action.
 *
 * The cost is that a saved `default` now sends `--permission-mode default`
 * where it used to send nothing. Nobody chose that distinction: the old UI
 * offered one option labelled "Default (Claude prompts for permissions)", and
 * `manual` is the preset that keeps that promise.
 *
 * Anything unrecognised floors to `manual` for the same reason.
 */
export function normalizeCliPermissionPreset(
  input: SprintEngineCliPermissionPreset | LegacyCliPermissionPreset | null | undefined,
): SprintEngineCliPermissionPreset {
  switch (input) {
    case 'none':
    case 'manual':
    case 'auto':
    case 'bypass':
      return input
    case 'default':
      return 'manual'
    case 'auto_workspace':
      return 'auto'
    case 'bypass_all':
      return 'bypass'
    default:
      return 'manual'
  }
}

/**
 * The automation block a workspace record carries, normalized. One copy for
 * both processes (MC-2160): the renderer store runs it on every projection
 * write, and main runs it when it composes a sprint run headlessly, so a
 * main-created run and a window-created one carry the identical block.
 */
export function normalizeSprintEngineAutoState(
  input: (
    Partial<SprintEngineAutoState> & { deliveredAgentNotificationEventIds?: string[] }
  ) | null | undefined,
): SprintEngineAutoState {
  const deliveredInput = Array.isArray(input?.deliveredAgentNotificationEventKeys)
    ? input.deliveredAgentNotificationEventKeys
    : Array.isArray(input?.deliveredAgentNotificationEventIds)
      ? input.deliveredAgentNotificationEventIds
      : []
  const deliveredAgentNotificationEventKeys = deliveredInput.length > 0
    ? deliveredInput.filter((eventKey): eventKey is string => typeof eventKey === 'string' && eventKey.trim().length > 0)
    : []
  const cliPermissionPreset = normalizeCliPermissionPreset(input?.cliPermissionPreset)
  const maxConcurrentAgents =
    typeof input?.maxConcurrentAgents === 'number' && Number.isFinite(input.maxConcurrentAgents)
      ? Math.max(1, Math.min(10, Math.floor(input.maxConcurrentAgents)))
      : 3

  const desiredMode = deriveSprintEngineAutomationDesiredMode(input)
  const runtimeState = normalizeSprintEngineAutomationRuntimeState(input?.runtimeState, desiredMode)

  return {
    desiredMode,
    runtimeState,
    reason: normalizeSprintEngineAutomationStopReason(input?.reason),
    reasonMessage: typeof input?.reasonMessage === 'string' ? input.reasonMessage : undefined,
    reasonTaskId: typeof input?.reasonTaskId === 'string' ? input.reasonTaskId : undefined,
    reasonAgentId: typeof input?.reasonAgentId === 'string' ? input.reasonAgentId : undefined,
    changedAt: typeof input?.changedAt === 'number' && Number.isFinite(input.changedAt)
      ? input.changedAt
      : undefined,
    cliPermissionPreset,
    maxConcurrentAgents,
    deliveredAgentNotificationEventKeys,
    // Preserve the one-shot completion-teardown marker: this normalizer runs on
    // every projection write, so dropping the field here would re-arm teardown
    // each poll and resurrect the kill-resumed-panel loop it exists to prevent.
    completionTeardownAt:
      typeof input?.completionTeardownAt === 'number' && Number.isFinite(input.completionTeardownAt)
        ? input.completionTeardownAt
        : undefined,
  }
}
