import type { SprintEngineRoleId, SprintEngineState } from '../types/workspace'
import {
  getOpenSprintEngineQualityGates,
  getSprintEngineTaskBoardColumn,
  isSprintEngineTaskLaunchable,
} from './sprintengine'

export function canLaunchSprintEngineInitialSpawn(
  role: SprintEngineRoleId,
  sprintEngineState: SprintEngineState,
): boolean {
  if (role === 'architect') return true

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
