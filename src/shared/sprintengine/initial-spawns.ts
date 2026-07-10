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

// The planning roles that own run bootstrap and may start before any claimable
// role work exists: the architect, or a soulless General that plans the run
// itself when no architect is rostered.
export function isSprintEnginePlanningRole(role: SprintEngineRoleId): boolean {
  return role === 'architect' || role === 'general'
}

export function canLaunchSprintEngineInitialSpawn(
  role: SprintEngineRoleId,
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
