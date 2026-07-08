import type { SprintEngineRoleId, SprintEngineState } from '../types/workspace'
import { isSprintEngineTaskLaunchable } from './sprintengine'

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
