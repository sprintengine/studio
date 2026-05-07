import { readFile } from 'fs/promises'
import { MobileSwarmCommandError } from './command-error'
import { resolveSprintEngineArtifactFilePath } from './artifact-path'
import type { ValidSwarmStatePath } from './state-path'
import {
  normalizeSwarmTasks,
  type SwarmTaskRecord,
} from './task-normalizer'

export type SwarmArtifactRecord = {
  id: string
  path?: string
}

type SwarmRuntimeAgentRecord = {
  role?: string
  status?: string
}

type RawSwarmState = {
  tasks?: unknown[]
  artifacts?: unknown[]
  swarmAgents?: Record<string, SwarmRuntimeAgentRecord>
}

export async function readRawSwarmState(state: ValidSwarmStatePath): Promise<RawSwarmState> {
  return JSON.parse(await readFile(state.statePath, 'utf8')) as RawSwarmState
}

export async function findSwarmArtifact(
  state: ValidSwarmStatePath,
  artifactId: string
): Promise<SwarmArtifactRecord> {
  const parsed = await readRawSwarmState(state)
  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : []
  const artifact = artifacts.flatMap((candidate): SwarmArtifactRecord[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const record = candidate as Record<string, unknown>
    if (record.id !== artifactId) return []
    return [{
      id: artifactId,
      ...(typeof record.path === 'string' && record.path.trim() ? { path: record.path } : {}),
    }]
  })[0]

  if (!artifact) {
    throw new MobileSwarmCommandError('artifact_not_found', 'Requested artifact was not found in the Sprint Engine state.', false)
  }

  if (artifact.path) {
    resolveSprintEngineArtifactFilePath(state, artifact.path)
  }

  return artifact
}

export async function findReadySwarmTask(
  state: ValidSwarmStatePath,
  taskId: string,
  role: string
): Promise<SwarmTaskRecord> {
  const parsed = await readRawSwarmState(state)
  const tasks = normalizeSwarmTasks(parsed.tasks)
  const task = tasks.find((candidate) => candidate.id === taskId)
  if (!task) {
    throw new MobileSwarmCommandError('task_not_ready', 'Requested task was not found in the Sprint Engine state.', false)
  }

  if (task.role !== role) {
    throw new MobileSwarmCommandError('task_not_ready', 'Requested task role does not match the mobile command role.', false)
  }

  if (task.ownerAgentId) {
    throw new MobileSwarmCommandError('task_not_ready', 'Requested task is already owned by an agent.', false)
  }

  if (task.status !== 'todo') {
    throw new MobileSwarmCommandError('task_not_ready', 'Requested task is not ready to start.', false)
  }

  const tasksById = new Map(tasks.map((candidate) => [candidate.id, candidate]))
  const incompleteDependency = task.dependsOn.find((dependencyId) => tasksById.get(dependencyId)?.status !== 'done')
  if (incompleteDependency) {
    throw new MobileSwarmCommandError('task_not_ready', `Requested task is blocked by dependency ${incompleteDependency}.`, false)
  }

  return task
}

export async function assertKnownActiveSwarmAgent(
  state: ValidSwarmStatePath,
  agentId: string
): Promise<void> {
  const parsed = await readRawSwarmState(state)
  const swarmAgents = parsed.swarmAgents && typeof parsed.swarmAgents === 'object' ? parsed.swarmAgents : {}
  const agent = swarmAgents[agentId]
  if (agent?.status === 'done') {
    throw new MobileSwarmCommandError('task_not_ready', 'Follow-up target agent is already done.', false)
  }
  if (agent) return

  const ownedTask = normalizeSwarmTasks(parsed.tasks).find((task) => task.ownerAgentId === agentId)
  if (!ownedTask || ownedTask.status === 'done') {
    throw new MobileSwarmCommandError('task_not_ready', 'Follow-up target agent is not active in this sprintengine.', false)
  }
}
