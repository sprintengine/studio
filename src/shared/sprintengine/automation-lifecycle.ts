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
  SprintEngineAutoState,
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
])

const stopReasons = new Set<SprintEngineAutomationStopReason>([
  'user_selected_manual',
  'folder_missing',
  'spawn_failed',
  'blocked_on_input',
  'all_tasks_done',
  'terminal_closed',
  'workspace_removed',
  'startup',
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

  // `complete` is a terminal runtime state. When every task is done the run's
  // agent panels are torn down (see `tearDownCompletedSprintRunAgents`),
  // and those terminal-close events arrive asynchronously — after the
  // completion transition — as `runner_paused{ reason: terminal_closed }`.
  // Without this guard they would demote a finished run back to `paused` (the
  // "An agent terminal was closed" pill seen on a 26/26 run). Only explicit
  // user intent (re-selecting an automation mode) leaves `complete`;
  // lifecycle-neutral pending-spawn bookkeeping still passes through.
  if (
    runtimeState === 'complete' &&
    event.type !== 'user_set_mode' &&
    event.type !== 'pending_spawns_changed'
  ) {
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
        pendingSpawns: enabled ? base.pendingSpawns : [],
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
        pendingSpawns: [],
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
        pendingSpawns: [],
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
        pendingSpawns: [],
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
        pendingSpawns: [],
      }

    case 'pending_spawns_changed':
      return {
        ...base,
        pendingSpawns: event.pendingSpawns,
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
