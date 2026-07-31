/**
 * Sprint Engine initial-spawn launch predicates, shared by the renderer and
 * the main process.
 *
 * Relocated verbatim from `src/renderer/src/utils/sprintengineInitialSpawns.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner, which reads this module), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). The renderer file remains as a
 * re-export shim, so every existing import site and test keeps working
 * unchanged.
 */
import type { SprintEngineRoleId, SprintEngineState } from './run-types'
import { isSprintEngineTaskLaunchable } from './state'

// The role that owns run bootstrap and may start before any claimable role
// work exists. Now a single definition (the renderer carried an independent
// copy) and a single role: `general` is gone, and "no role" no longer has to be
// smuggled in AS a role to reach the coordination path — a roleless run
// coordinates through `sprintEngineCoordinatorSeat`, which this predicate
// cannot express. MC-2057 leaves it here only until T4 replaces the four
// dispatch sites and `canLaunchSprintEngineInitialSpawn` below with that seat
// question; nothing new should call it.
export function isSprintEnginePlanningRole(role: SprintEngineRoleId | undefined): boolean {
  return role === 'architect'
}

export function canLaunchSprintEngineInitialSpawn(
  role: SprintEngineRoleId | undefined,
  sprintEngineState: SprintEngineState,
): boolean {
  if (isSprintEnginePlanningRole(role)) return true

  // Single-owner tasks (MC-1542): a role only has launchable work when a task
  // assigned to it is claimable. There is no second, reviewer-shaped source of
  // work any more — the task's own owner walks its review phase.
  return sprintEngineState.tasks.some((task) =>
    task.role === role && isSprintEngineTaskLaunchable(task, sprintEngineState)
  )
}
