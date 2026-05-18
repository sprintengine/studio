import type { SprintEngineAutoPendingSpawn, SprintEngineQualityGate, SprintEngineTask } from '../types/workspace'
import { getOpenSprintEngineQualityGates, getSprintEngineTaskBoardColumn } from './sprintengine'

export type SprintEngineAutoRunActiveGateClaim = {
  gate: SprintEngineQualityGate
  claimedBy: string
}

export function sprintEngineAutoRunWorkKey(input: { taskId: string; gateId?: string | null }): string {
  return input.gateId ? `gate:${input.taskId}:${input.gateId}` : `task:${input.taskId}`
}

export function getClaimableSprintEngineAutoRunGates(
  task: SprintEngineTask,
  tasks: SprintEngineTask[]
): SprintEngineQualityGate[] {
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).filter(
    (gate) => gate.status === 'pending' && gate.phase === taskColumn
  )
}

export function getActiveSprintEngineAutoRunGateClaims(
  task: SprintEngineTask,
  tasks: SprintEngineTask[]
): SprintEngineAutoRunActiveGateClaim[] {
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).flatMap((gate) => {
    if (gate.status !== 'in_progress' || gate.phase !== taskColumn) return []
    const attempt = [...gate.attempts].reverse().find((candidate) =>
      candidate.status === 'in_progress' && typeof candidate.claimedBy === 'string' && candidate.claimedBy
    )
    return attempt?.claimedBy ? [{ gate, claimedBy: attempt.claimedBy }] : []
  })
}

export function isSprintEngineAutoPendingSpawnStillRelevant(
  pending: SprintEngineAutoPendingSpawn,
  task: SprintEngineTask | undefined,
  tasks: SprintEngineTask[]
): boolean {
  if (!task) return false
  if (!pending.gateId) return false
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).some((gate) =>
    gate.id === pending.gateId
      && gate.phase === taskColumn
      && (gate.status === 'pending' || gate.status === 'in_progress')
  )
}
