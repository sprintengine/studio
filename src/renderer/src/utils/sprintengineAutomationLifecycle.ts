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
  SprintEngineAutoState,
  SprintEngineState,
  Workspace,
} from '../types/workspace'

export {
  deriveSprintEngineAutomationDesiredMode,
  normalizeSprintEngineAutomationRuntimeState,
  normalizeSprintEngineAutomationStopReason,
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
  sprintEngineAutomationShouldRun,
  transitionSprintEngineAutomation,
} from '../../../shared/sprintengine/automation-lifecycle'

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
 * (`in_progress` / `needs_input`); or the auto-run supervisor has a pending
 * spawn for it (a just-spawned worker that has not claimed yet — projection lag
 * must not misclassify an early close as routine). A task in its `review` phase
 * is still held by its single owner, so it is covered by the `currentTaskId`
 * claim above rather than by the owned-task status check.
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
  if (rosterAgent?.currentTaskId || rosterAgent?.currentDispatch) return true
  if (sprintEngineState.tasks?.some((task) =>
    task.ownerAgentId === agentId
    && (task.status === 'in_progress' || task.status === 'needs_input')
  )) return true
  return (autoState?.pendingSpawns ?? []).some((spawn) => spawn.agentId === agentId)
}
