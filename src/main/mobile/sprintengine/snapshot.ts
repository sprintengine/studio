import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { readFile, stat } from 'fs/promises'

const mobileControlProtocolVersion = 1 as const
const defaultPublishThrottleMs = 1000

type SprintEngineTaskStatus = 'todo' | 'in_progress' | 'needs_input' | 'done'
type MobileTaskStatus = 'todo' | 'ready' | 'in_progress' | 'needs_input' | 'blocked' | 'done'
type MobileArtifactStatus = 'draft' | 'ready_for_review' | 'approved' | 'changes_requested'

export type MobileSprintEngineTaskSnapshot = {
  taskId: string
  title: string
  role: string
  status: MobileTaskStatus
  ownerAgentId?: string
  dependsOn: string[]
}

export type MobileSprintEngineArtifactSnapshot = {
  artifactId: string
  title: string
  kind: string
  status: MobileArtifactStatus
  taskId?: string
  path?: string
}

export type MobileSprintEngineSnapshot = {
  sprintEngineId: string
  name: string
  workspacePath: string
  statePath: string
  planPath?: string
  snapshotVersion: string
  updatedAt: string
  board: {
    todo: number
    ready: number
    inProgress: number
    needsInput: number
    blocked: number
    done: number
  }
  tasks: MobileSprintEngineTaskSnapshot[]
  artifacts: MobileSprintEngineArtifactSnapshot[]
}

export type MobileControlSnapshot = {
  protocolVersion: typeof mobileControlProtocolVersion
  generatedAt: string
  desktopSessionId: string
  sprintEngines: MobileSprintEngineSnapshot[]
}

export type MobileSprintEngineSnapshotRequest = {
  desktopSessionId: string
  statePaths: string[]
  generatedAt?: string
}

type MobileSprintEngineSnapshotListener = (snapshot: MobileControlSnapshot) => void

type MobileSprintEngineSnapshotServiceOptions = {
  publishThrottleMs?: number
}

type RawSprintEngineState = {
  sprintengine?: Record<string, unknown>
  tasks?: unknown[]
  artifacts?: unknown[]
}

type NormalizedTask = {
  id: string
  title: string
  role: string
  status: SprintEngineTaskStatus
  ownerAgentId: string | null
  dependsOn: string[]
}

export class MobileSprintEngineSnapshotService {
  private readonly listeners = new Set<MobileSprintEngineSnapshotListener>()
  private readonly publishThrottleMs: number
  private lastPublishedAt = 0
  private pendingRequest: MobileSprintEngineSnapshotRequest | null = null
  private publishTimer: NodeJS.Timeout | null = null

  constructor(options: MobileSprintEngineSnapshotServiceOptions = {}) {
    this.publishThrottleMs = Math.max(0, options.publishThrottleMs ?? defaultPublishThrottleMs)
  }

  subscribe(listener: MobileSprintEngineSnapshotListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async readSnapshot(request: MobileSprintEngineSnapshotRequest): Promise<MobileControlSnapshot> {
    const generatedAt = request.generatedAt ?? new Date().toISOString()
    const settledSprintEngines = await Promise.allSettled(
      request.statePaths.map((statePath) => readSprintEngineSnapshot(statePath))
    )
    const sprintEngines = settledSprintEngines.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])

    return {
      protocolVersion: mobileControlProtocolVersion,
      generatedAt,
      desktopSessionId: request.desktopSessionId,
      sprintEngines,
    }
  }

  async publishSnapshot(request: MobileSprintEngineSnapshotRequest): Promise<MobileControlSnapshot | null> {
    const now = Date.now()
    const elapsedMs = now - this.lastPublishedAt
    if (elapsedMs >= this.publishThrottleMs) {
      this.clearPublishTimer()
      const snapshot = await this.readSnapshot(request)
      this.emit(snapshot)
      this.lastPublishedAt = now
      return snapshot
    }

    this.pendingRequest = request
    if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => {
        void this.flushPendingSnapshot()
      }, this.publishThrottleMs - elapsedMs)
    }
    return null
  }

  async flushPendingSnapshot(): Promise<MobileControlSnapshot | null> {
    const request = this.pendingRequest
    if (!request) {
      this.clearPublishTimer()
      return null
    }

    this.pendingRequest = null
    this.clearPublishTimer()
    const snapshot = await this.readSnapshot(request)
    this.emit(snapshot)
    this.lastPublishedAt = Date.now()
    return snapshot
  }

  shutdown(): void {
    this.clearPublishTimer()
    this.pendingRequest = null
    this.listeners.clear()
  }

  private emit(snapshot: MobileControlSnapshot): void {
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private clearPublishTimer(): void {
    if (!this.publishTimer) return
    clearTimeout(this.publishTimer)
    this.publishTimer = null
  }
}

export async function readSprintEngineSnapshot(statePathInput: string): Promise<MobileSprintEngineSnapshot> {
  const statePath = resolve(statePathInput)
  if (basename(statePath) !== 'state.yaml') {
    throw new Error('Sprint Engine snapshot state path must point to a state.yaml file.')
  }

  const [content, stateStats] = await Promise.all([
    readFile(statePath, 'utf8'),
    stat(statePath),
  ])
  const parsed = JSON.parse(content) as RawSprintEngineState
  const teamDirectory = dirname(statePath)
  const sprintEngineRootDirectory = dirname(teamDirectory)
  const workspacePath = dirname(sprintEngineRootDirectory)
  const sprintEngineId = basename(teamDirectory)
  const sprintengine = parsed.sprintengine && typeof parsed.sprintengine === 'object' ? parsed.sprintengine : {}
  const updatedAt = isoStringOrNull(sprintengine.updatedAt) ?? stateStats.mtime.toISOString()
  const tasks = normalizeTasks(parsed.tasks)
  const taskSnapshots = tasks.map((task) => toTaskSnapshot(task, tasks))
  const artifacts = normalizeArtifacts(parsed.artifacts)
  const board = countBoard(taskSnapshots)
  const snapshotVersion = buildSnapshotVersion({
    updatedAt,
    tasks: taskSnapshots,
    artifacts,
  })

  return {
    sprintEngineId,
    name: stringOrFallback(sprintengine.name, sprintEngineId),
    workspacePath,
    statePath,
    planPath: join(teamDirectory, 'plan.md'),
    snapshotVersion,
    updatedAt,
    board,
    tasks: taskSnapshots,
    artifacts,
  }
}

function normalizeTasks(value: unknown): NormalizedTask[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return []
    const record = task as Record<string, unknown>
    const id = stringOrFallback(record.id, `task-${index + 1}`)
    return [{
      id,
      title: stringOrFallback(record.title, id),
      role: stringOrFallback(record.role, 'developer'),
      status: normalizeTaskStatus(record.status),
      ownerAgentId: typeof record.ownerAgentId === 'string' && record.ownerAgentId.trim()
        ? record.ownerAgentId
        : null,
      dependsOn: stringArray(record.dependsOn),
    }]
  })
}

function normalizeArtifacts(value: unknown): MobileSprintEngineArtifactSnapshot[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return []
    const record = artifact as Record<string, unknown>
    const artifactId = stringOrNull(record.id)
    const status = normalizeArtifactStatus(record.status)
    if (!artifactId || !status) return []

    return [{
      artifactId,
      title: stringOrFallback(record.title, artifactId || `Artifact ${index + 1}`),
      kind: stringOrFallback(record.kind, 'unknown'),
      status,
      ...(typeof record.taskId === 'string' && record.taskId.trim() ? { taskId: record.taskId } : {}),
      ...(typeof record.path === 'string' && record.path.trim() ? { path: record.path } : {}),
    }]
  })
}

function toTaskSnapshot(task: NormalizedTask, tasks: NormalizedTask[]): MobileSprintEngineTaskSnapshot {
  const status = getMobileTaskStatus(task, tasks)
  return {
    taskId: task.id,
    title: task.title,
    role: task.role,
    status,
    ...(task.ownerAgentId ? { ownerAgentId: task.ownerAgentId } : {}),
    dependsOn: task.dependsOn,
  }
}

function getMobileTaskStatus(task: NormalizedTask, tasks: NormalizedTask[]): MobileTaskStatus {
  if (task.status === 'done' || task.status === 'in_progress' || task.status === 'needs_input') {
    return task.status
  }

  const dependenciesDone = task.dependsOn.every((dependencyId) =>
    tasks.some((candidate) => candidate.id === dependencyId && candidate.status === 'done')
  )
  return dependenciesDone ? 'ready' : 'todo'
}

function countBoard(tasks: MobileSprintEngineTaskSnapshot[]): MobileSprintEngineSnapshot['board'] {
  const board: MobileSprintEngineSnapshot['board'] = {
    todo: 0,
    ready: 0,
    inProgress: 0,
    needsInput: 0,
    blocked: 0,
    done: 0,
  }

  for (const task of tasks) {
    switch (task.status) {
      case 'ready':
        board.ready += 1
        break
      case 'in_progress':
        board.inProgress += 1
        break
      case 'needs_input':
        board.needsInput += 1
        break
      case 'blocked':
        board.blocked += 1
        break
      case 'done':
        board.done += 1
        break
      case 'todo':
        board.todo += 1
        break
    }
  }

  return board
}

function normalizeTaskStatus(value: unknown): SprintEngineTaskStatus {
  if (value === 'in_progress' || value === 'needs_input' || value === 'done') return value
  return 'todo'
}

function normalizeArtifactStatus(value: unknown): MobileArtifactStatus | null {
  if (
    value === 'draft'
    || value === 'ready_for_review'
    || value === 'approved'
    || value === 'changes_requested'
  ) {
    return value
  }
  return null
}

function buildSnapshotVersion(value: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24)
  return `snap_${digest}`
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function stringOrFallback(value: unknown, fallback: string): string {
  return stringOrNull(value) ?? fallback
}

function isoStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return Number.isFinite(Date.parse(value)) ? value : null
}
