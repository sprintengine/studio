/**
 * Renderer shim over the shared Sprint Engine automation lifecycle.
 *
 * The pure state machine relocated to
 * `src/shared/sprintengine/automation-lifecycle.ts` (MC-1567: main owns the
 * mode intent and runs the same transitions), following the established
 * planner-shim pattern (`sprintengineAutoRunPlanner.ts`). Existing renderer
 * import sites keep working unchanged; only the helpers that read
 * renderer-specific shapes (`Workspace`, `SprintEngineState`) live here.
 */
import type {
  SprintEngineState,
  Workspace,
} from '../types/workspace'

export {
  deriveSprintEngineAutomationDesiredMode,
  normalizeSprintEngineAutomationRuntimeState,
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
  sprintEngineAutomationShouldRun,
  transitionSprintEngineAutomation,
} from '../../../shared/sprintengine/automation-lifecycle'

/**
 * The single dormancy bit. A run is dormant once its automation lifecycle
 * reaches a terminal state — `complete` (every task done) or `canceled` (the
 * user stopped the run, MC-1604) — the persisted signal every renderer activity
 * source honours to stop periodic work. It is the resulting *state*;
 * `isCompletedSprintEngineRun` / `isCanceledSprintEngineRun` are the signals
 * that *trigger* the transition. The reducer's terminal-state guard makes both
 * one-way (only `user_set_mode` leaves them), so dormancy ends only by explicit
 * user action.
 */
export function isSprintEngineWorkspaceDormant(
  workspace: Pick<Workspace, 'sprintEngineAutoState'> | null | undefined,
): boolean {
  const runtimeState = workspace?.sprintEngineAutoState?.runtimeState
  return runtimeState === 'complete' || runtimeState === 'canceled'
}

/**
 * Whether closing this agent's terminal/tab is plausibly a user intervention
 * that should pause the whole run — as opposed to the routine per-task
 * teardown MC-1444 made normal (one session per task: a worker's terminal is
 * disposed every time its task finishes, and roster tabs are removed
 * programmatically through the same DELETE_TAB path a user close takes).
 *
 * "Live run work" means: the roster says the agent currently holds a task
 * claim (`currentTaskId`) or an active dispatch (`currentDispatch` — assigned
 * work it may not have claimed yet); or a task it owns is actively being worked
 * (`in_progress` / `needs_input`). A task in its `review` phase
 * is still held by its single owner, so it is covered by the `currentTaskId`
 * claim above rather than by the owned-task status check.
 *
 * Closing a workless agent's terminal stays lifecycle-neutral — the PTY kill
 * and launch-flag reset still happen; the run keeps going.
 */
export function sprintEngineAgentHasLiveRunWork(
  sprintEngineState: Pick<SprintEngineState, 'sprintEngineAgents' | 'tasks'> | null | undefined,
  agentId: string | undefined,
): boolean {
  if (!agentId || !sprintEngineState) return false
  const rosterAgent = sprintEngineState.sprintEngineAgents?.[agentId]
  if (rosterAgent?.currentTaskId || rosterAgent?.currentDispatch) return true
  return Boolean(sprintEngineState.tasks?.some((task) =>
    task.ownerAgentId === agentId
    && (task.status === 'in_progress' || task.status === 'needs_input')
  ))
}
