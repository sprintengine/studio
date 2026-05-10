import { readFile } from 'fs/promises'
import { MobileSprintEngineCommandError } from './command-error'
import { resolveSprintEngineArtifactFilePath } from './artifact-path'
import type { ValidSprintEngineStatePath } from './state-path'
import {
  normalizeSprintEngineTasks,
  type SprintEngineTaskRecord,
} from './task-normalizer'

export type SprintEngineArtifactRecord = {
  id: string
  path?: string
}

type SprintEngineRuntimeAgentRecord = {
  role?: string
  status?: string
}

type RawSprintEngineState = {
  tasks?: unknown[]
  artifacts?: unknown[]
  sprintEngineAgents?: Record<string, SprintEngineRuntimeAgentRecord>
}

export async function readRawSprintEngineState(state: ValidSprintEngineStatePath): Promise<RawSprintEngineState> {
  return JSON.parse(await readFile(state.statePath, 'utf8')) as RawSprintEngineState
}

export async function findSprintEngineArtifact(
  state: ValidSprintEngineStatePath,
  artifactId: string
): Promise<SprintEngineArtifactRecord> {
  const parsed = await readRawSprintEngineState(state)
  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : []
  const artifact = artifacts.flatMap((candidate): SprintEngineArtifactRecord[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const record = candidate as Record<string, unknown>
    if (record.id !== artifactId) return []
    return [{
      id: artifactId,
      ...(typeof record.path === 'string' && record.path.trim() ? { path: record.path } : {}),
    }]
  })[0]

  if (!artifact) {
    throw new MobileSprintEngineCommandError('artifact_not_found', 'Requested artifact was not found in the Sprint Engine state.', false)
  }

  if (artifact.path) {
    resolveSprintEngineArtifactFilePath(state, artifact.path)
  }

  return artifact
}

export async function findReadySprintEngineTask(
  state: ValidSprintEngineStatePath,
  taskId: string,
  role: string
): Promise<SprintEngineTaskRecord> {
  const parsed = await readRawSprintEngineState(state)
  const tasks = normalizeSprintEngineTasks(parsed.tasks)
  const task = tasks.find((candidate) => candidate.id === taskId)
  if (!task) {
    throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task was not found in the Sprint Engine state.', false)
  }

  if (task.role !== role) {
    throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task role does not match the mobile command role.', false)
  }

  if (task.ownerAgentId) {
    throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task is already owned by an agent.', false)
  }

  if (task.status !== 'todo') {
    throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task is not ready to start.', false)
  }

  const tasksById = new Map(tasks.map((candidate) => [candidate.id, candidate]))
  const incompleteDependency = task.dependsOn.find((dependencyId) => tasksById.get(dependencyId)?.status !== 'done')
  if (incompleteDependency) {
    throw new MobileSprintEngineCommandError('task_not_ready', `Requested task is blocked by dependency ${incompleteDependency}.`, false)
  }

  return task
}

export async function assertKnownActiveSprintEngineAgent(
  state: ValidSprintEngineStatePath,
  agentId: string
): Promise<void> {
  const parsed = await readRawSprintEngineState(state)
  const sprintEngineAgents = parsed.sprintEngineAgents && typeof parsed.sprintEngineAgents === 'object' ? parsed.sprintEngineAgents : {}
  const agent = sprintEngineAgents[agentId]
  if (agent?.status === 'done') {
    throw new MobileSprintEngineCommandError('task_not_ready', 'Follow-up target agent is already done.', false)
  }
  if (agent) return

  const ownedTask = normalizeSprintEngineTasks(parsed.tasks).find((task) => task.ownerAgentId === agentId)
  if (!ownedTask || ownedTask.status === 'done') {
    throw new MobileSprintEngineCommandError('task_not_ready', 'Follow-up target agent is not active in this sprintengine.', false)
  }
}
