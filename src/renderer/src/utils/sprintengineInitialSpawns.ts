import type { SprintEngineRoleId, SprintEngineState } from '../types/workspace'
import {
  getOpenSprintEngineQualityGates,
  getSprintEngineTaskBoardColumn,
  isSprintEngineTaskLaunchable,
} from './sprintengine'

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

  return sprintEngineState.tasks.some((task) =>
    task.role === role && isSprintEngineTaskLaunchable(task, sprintEngineState)
  )
  || sprintEngineState.tasks.some((task) => {
    const taskColumn = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
    return getOpenSprintEngineQualityGates(task).some((gate) =>
      gate.role === role && gate.status === 'pending' && gate.phase === taskColumn
    )
  })
}
