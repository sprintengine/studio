import type {
  SprintEngineAutoState,
  SprintEngineAutomationDesiredMode,
  SprintEngineAutomationEvent,
  SprintEngineAutomationRuntimeState,
  SprintEngineAutomationStopReason,
  SprintEngineState,
  Workspace,
} from '../types/workspace'

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

function isDesiredMode(input: unknown): input is SprintEngineAutomationDesiredMode {
  return typeof input === 'string' && desiredModes.has(input as SprintEngineAutomationDesiredMode)
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

/**
 * The single dormancy bit. A finished run is dormant once its automation
 * lifecycle reaches the terminal `complete` state — the one persisted signal
 * that every renderer activity source honours to stop periodic work. It is the
 * resulting *state* of completion; `isCompletedSprintEngineRun` (task-level) is
 * the signal that *triggers* the transition into it. The reducer's
 * terminal-state guard makes `complete` one-way (only `user_set_mode` leaves
 * it), so dormancy ends only by explicit user action.
 */
export function isSprintEngineWorkspaceDormant(
  workspace: Pick<Workspace, 'sprintEngineAutoState'> | null | undefined,
): boolean {
  return workspace?.sprintEngineAutoState?.runtimeState === 'complete'
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

/**
 * Whether closing this agent's terminal/tab is plausibly a user intervention
 * that should pause the whole run — as opposed to the routine per-task
 * teardown MC-1444 made normal (one session per task: a worker's terminal is
 * disposed every time its task finishes, and roster tabs are removed
 * programmatically through the same DELETE_TAB path a user close takes).
 *
 * "Live run work" means: the roster says the agent currently holds a task
 * claim (`currentTaskId`), a gate claim (`currentGateId` — reviewers carry a
 * gate with no task claim), or an active dispatch (`currentDispatch` —
 * assigned work it may not have claimed yet); or a task it owns is actively
 * being worked (`in_progress` / `needs_input`); or the auto-run supervisor
 * has a pending spawn for it (a just-spawned worker that has not claimed yet
 * — projection lag must not misclassify an early close as routine). Tasks
 * sitting in `review`/`testing` do NOT count: MC-1444 disposes the
 * implementer's window in that publish→verdict gap by design, so teardown
 * there is routine.
 *
 * Closing a workless agent's terminal stays lifecycle-neutral — the PTY kill
 * and launch-flag reset still happen; the run keeps going.
 */
export function sprintEngineAgentHasLiveRunWork(
  sprintEngineState: Pick<SprintEngineState, 'sprintEngineAgents' | 'tasks'> | null | undefined,
  autoState: Partial<SprintEngineAutoState> | null | undefined,
  agentId: string | undefined,
): boolean {
  if (!agentId || !sprintEngineState) return false
  const rosterAgent = sprintEngineState.sprintEngineAgents?.[agentId]
  if (rosterAgent?.currentTaskId || rosterAgent?.currentGateId || rosterAgent?.currentDispatch) return true
  if (sprintEngineState.tasks?.some((task) =>
    task.ownerAgentId === agentId
    && (task.status === 'in_progress' || task.status === 'needs_input')
  )) return true
  return (autoState?.pendingSpawns ?? []).some((spawn) => spawn.agentId === agentId)
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
