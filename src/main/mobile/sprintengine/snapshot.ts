import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import type {
  SwitchboardReadResult,
  SwitchboardRunnerExecution,
  SwitchboardRunnerResult,
  SwitchboardTaskRecord,
  WatchtowerRun,
  WatchtowerRunListResult,
} from '../../../shared/switchboard'
import {
  getSwitchboardRunnerState,
  listWatchtowerRuns,
  readAllSwitchboardTasks,
} from '../../switchboard-files'
import type { MobileControlCommandType } from '../../../shared/mobile-control/protocol'

const mobileControlProtocolVersion = 1 as const
const mobileControlWorkspaceSnapshotVersion = 2 as const
const defaultPublishThrottleMs = 1000
const maxWorkspaceCollectionItems = 20
const maxNestedWorkspaceCollectionItems = 10
const mobileSnapshotCommandTypes = [
  'snapshot.request',
  'artifact.read',
  'sprintengine.create',
  'task.start',
  'artifact.approve',
  'artifact.requestChanges',
  'agent.followUp',
  'device.revoke',
] as const satisfies readonly MobileControlCommandType[]

export const defaultMobileSnapshotCommands: readonly MobileControlCommandType[] = mobileSnapshotCommandTypes

type SprintEngineTaskStatus = 'todo' | 'ready' | 'in_progress' | 'needs_input' | 'done'
type MobileTaskStatus = 'todo' | 'ready' | 'in_progress' | 'needs_input' | 'blocked' | 'done'
type MobileArtifactStatus = 'draft' | 'ready_for_review' | 'approved' | 'changes_requested'
type MobileWorkspaceStatus = 'idle' | 'running' | 'needs_input' | 'blocked' | 'complete' | 'error' | 'unknown'

export type MobileSprintEngineTaskSnapshot = {
  taskId: string
  title: string
  role: string
  status: MobileTaskStatus
  ownerAgentId?: string
  dependsOn: string[]
  needsInput?: {
    kind?: string
    reason?: string
    question?: string
    suggestedResolution?: string
    artifactId?: string
  }
  evidence?: {
    summary?: string
    touchedFileCount?: number
    commandCount?: number
    resultCount?: number
  }
  feedback?: {
    confidencePct?: number
    hallucinationRiskPct?: number
  }
  reviewSignals?: {
    findingCount?: number
    issueCount?: number
    verdict?: string
  }
  release?: {
    requestedBy?: string
    reason?: string
  }
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
  roster?: Record<string, { role?: string; status?: string; currentTaskId?: string | null }>
  runSummary?: Record<string, string | number | boolean | null>
  planReview?: Record<string, string | number | boolean | null>
  locks?: {
    warnings?: unknown[]
    locks?: unknown[]
  }
  activity?: {
    count: number
    latest?: unknown
  }
  counts?: {
    ready?: number
    needsInput?: number
  }
}

export type MobileWorkspaceSnapshot = {
  workspaceId: string
  kind: 'sprintengine' | 'switchboard' | 'watchtower' | 'multiloop'
  name: string
  workspacePath?: string
  statePath?: string
  updatedAt: string
  capabilities: ('summary.read' | 'detail.read' | 'logs.read')[]
  detailVersion: typeof mobileControlWorkspaceSnapshotVersion
  summary: {
    status: MobileWorkspaceStatus
    headline?: string
    counts?: Record<string, number>
  }
  detail?: {
    kind: 'sprintengine'
    data: {
      sprintEngineId: string
      snapshotVersion: string
      board: MobileSprintEngineSnapshot['board']
      roster?: Record<string, { role?: string; status?: string; currentTaskId?: string | null }>
      runSummary?: Record<string, string | number | boolean | null>
      planReview?: Record<string, string | number | boolean | null>
    }
  }
  | {
    kind: 'switchboard'
    data: {
      inboxCount?: number
      laneCounts?: Record<string, number>
      activeExecutionCount?: number
      tasks?: MobileSwitchboardTaskSummary[]
      inboxItems?: MobileSwitchboardTaskSummary[]
      comments?: MobileSwitchboardCommentSummary[]
      evidence?: MobileSwitchboardEvidenceSummary[]
      logs?: MobileSwitchboardLogSummary[]
    }
  }
  | {
    kind: 'watchtower'
    data: {
      activeRunCount?: number
      latestRunStatus?: string
      generatedInboxCount?: number
      runs?: MobileWatchtowerRunSummary[]
      generatedInboxItems?: MobileWatchtowerGeneratedInboxSummary[]
    }
  }
  | {
    kind: 'multiloop'
    data: {
      loopId?: string
      milestoneCount?: number
      blockerCount?: number
      linkedSprintEngineId?: string
      milestones?: MobileMultiloopMilestoneSummary[]
      blockers?: MobileMultiloopBlockerSummary[]
    }
  }
}

type MobileSwitchboardSourceSummary = {
  type: string
  externalId?: string | null
  externalKey?: string | null
  externalUrl?: string | null
}

type MobileSwitchboardTaskSummary = {
  taskId: string
  identifier: string
  title: string
  status: string
  lane: string
  updatedAt: string
  source: MobileSwitchboardSourceSummary
  priority?: number | null
  claimedBy?: string | null
}

type MobileSwitchboardCommentSummary = {
  taskId: string
  commentId: string
  kind: string
  body: string
  createdAt: string
  authorName?: string | null
  confidencePct?: number | null
}

type MobileSwitchboardEvidenceSummary = {
  taskId: string
  summary?: string
  artifactCount: number
  commandCount: number
  touchedFileCount: number
  updatedAt: string
}

type MobileSwitchboardLogSummary = {
  taskId?: string
  executionId: string
  status?: string | null
  agentId?: string | null
  startedAt: string
  completedAt?: string | null
  summary?: string | null
}

type MobileWatchtowerRunSummary = {
  runId: string
  status: string
  preset: string
  createdAt: string
  completedAt?: string | null
  validCount: number
  invalidCount: number
  generatedInboxCount: number
  agentCount: number
}

type MobileWatchtowerGeneratedInboxSummary = {
  runId: string
  taskId: string
  source: 'watchtower'
}

type MobileMultiloopMilestoneSummary = {
  milestoneId: string
  title: string
  status?: string
  updatedAt?: string
  linkedSprintEngineId?: string
}

type MobileMultiloopBlockerSummary = {
  blockerId: string
  title: string
  status?: string
  updatedAt?: string
}

export type MobileControlSnapshot = {
  protocolVersion: typeof mobileControlProtocolVersion
  generatedAt: string
  desktopSessionId: string
  snapshotVersion?: string
  commands?: MobileControlCommandType[]
  sprintEngines: MobileSprintEngineSnapshot[]
  workspaces?: MobileWorkspaceSnapshot[]
}

export type MobileSprintEngineSnapshotRequest = {
  desktopSessionId: string
  statePaths: string[]
  workspaceRoots?: string[]
  commands?: MobileControlCommandType[]
  generatedAt?: string
}

type MobileSprintEngineSnapshotListener = (snapshot: MobileControlSnapshot) => void

type MobileSprintEngineSnapshotServiceOptions = {
  publishThrottleMs?: number
  supportedCommands?: readonly MobileControlCommandType[]
  stateReaders?: Partial<DesktopWorkspaceStateReaders>
}

type RawSprintEngineState = {
  sprintengine?: Record<string, unknown>
  tasks?: unknown[]
  artifacts?: unknown[]
  sprintEngineAgents?: Record<string, unknown>
  runSummary?: unknown
  summary?: unknown
  planReview?: unknown
  planReviewState?: unknown
}

type NormalizedTask = {
  id: string
  title: string
  role: string
  status: SprintEngineTaskStatus
  ownerAgentId: string | null
  dependsOn: string[]
  needsInput?: {
    kind?: string
    reason?: string
    question?: string
    suggestedResolution?: string
    artifactId?: string
  }
  evidence?: {
    summary?: string
    touchedFileCount?: number
    commandCount?: number
    resultCount?: number
  }
  feedback?: {
    confidencePct?: number
    hallucinationRiskPct?: number
  }
  reviewSignals?: {
    findingCount?: number
    issueCount?: number
    verdict?: string
  }
  release?: {
    requestedBy?: string
    reason?: string
  }
}

type DesktopWorkspaceStateReaders = {
  readSwitchboardTasks(input: { workspaceRoot: string }): Promise<SwitchboardReadResult>
  getSwitchboardRunnerState(input: string): Promise<SwitchboardRunnerResult>
  listWatchtowerRuns(workspaceRoot: string): Promise<WatchtowerRunListResult>
  readMultiloopStates(workspaceRoot: string): Promise<MobileWorkspaceSnapshot[]>
}

const defaultStateReaders: DesktopWorkspaceStateReaders = {
  readSwitchboardTasks: readAllSwitchboardTasks,
  getSwitchboardRunnerState,
  listWatchtowerRuns,
  readMultiloopStates: readMultiloopWorkspaceSnapshots,
}

export class MobileSprintEngineSnapshotService {
  private readonly listeners = new Set<MobileSprintEngineSnapshotListener>()
  private readonly publishThrottleMs: number
  private lastPublishedAt = 0
  private pendingRequest: MobileSprintEngineSnapshotRequest | null = null
  private publishTimer: NodeJS.Timeout | null = null
  private readonly stateReaders: DesktopWorkspaceStateReaders
  private readonly supportedCommands: MobileControlCommandType[]

  constructor(options: MobileSprintEngineSnapshotServiceOptions = {}) {
    this.publishThrottleMs = Math.max(0, options.publishThrottleMs ?? defaultPublishThrottleMs)
    this.stateReaders = { ...defaultStateReaders, ...options.stateReaders }
    this.supportedCommands = normalizeMobileControlCommands(options.supportedCommands ?? defaultMobileSnapshotCommands)
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
    const workspaceRoots = uniqueResolved([
      ...(request.workspaceRoots ?? []),
      ...sprintEngines.map((sprintEngine) => sprintEngine.workspacePath),
    ])
    const desktopWorkspaces = await this.readDesktopWorkspaceSnapshots(workspaceRoots, generatedAt)
    const workspaces = [
      ...sprintEngines.map(toSprintEngineWorkspaceSnapshot),
      ...desktopWorkspaces,
    ]

    return {
      protocolVersion: mobileControlProtocolVersion,
      generatedAt,
      desktopSessionId: request.desktopSessionId,
      snapshotVersion: buildSnapshotVersion({
        updatedAt: generatedAt,
        tasks: sprintEngines.flatMap((sprintEngine) => sprintEngine.tasks),
        artifacts: sprintEngines.flatMap((sprintEngine) => sprintEngine.artifacts),
        workspaces,
      }),
      commands: normalizeMobileControlCommands(request.commands ?? this.supportedCommands),
      sprintEngines,
      workspaces,
    }
  }

  async publishSnapshot(request: MobileSprintEngineSnapshotRequest): Promise<MobileControlSnapshot | null> {
    const now = Date.now()
    const elapsedMs = now - this.lastPublishedAt
    if (elapsedMs >= this.publishThrottleMs) {
      this.clearPublishTimer()
      const snapshot = await this.readSnapshot(request)
      this.emit(snapshot)
      this.lastPublishedAt = Date.now()
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

  private async readDesktopWorkspaceSnapshots(workspaceRoots: string[], generatedAt: string): Promise<MobileWorkspaceSnapshot[]> {
    const settled = await Promise.allSettled(workspaceRoots.map(async (workspaceRoot) => {
      const [switchboard, watchtower, multiloop] = await Promise.all([
        readSwitchboardWorkspaceSnapshot(workspaceRoot, generatedAt, this.stateReaders),
        readWatchtowerWorkspaceSnapshot(workspaceRoot, generatedAt, this.stateReaders),
        this.stateReaders.readMultiloopStates(workspaceRoot),
      ])
      return [switchboard, watchtower, ...multiloop].filter((workspace): workspace is MobileWorkspaceSnapshot => Boolean(workspace))
    }))

    return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  }
}

export async function readSprintEngineSnapshot(statePathInput: string): Promise<MobileSprintEngineSnapshot> {
  const statePath = resolve(statePathInput)
  if (basename(statePath) !== 'state.yaml') {
    throw new Error('Sprint Engine snapshot state path must point to a state.yaml file.')
  }

  const teamDirectory = dirname(statePath)
  const projectionSnapshot = await readSprintEngineProjectionSnapshot(statePath, teamDirectory)
  if (projectionSnapshot) return projectionSnapshot

  const [content, stateStats] = await Promise.all([
    readFile(statePath, 'utf8'),
    stat(statePath),
  ])
  const parsed = JSON.parse(content) as RawSprintEngineState
  const sprintEngineRootDirectory = dirname(teamDirectory)
  const workspacePath = dirname(dirname(sprintEngineRootDirectory))
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
    ...(normalizeRoster(parsed.sprintEngineAgents) ? { roster: normalizeRoster(parsed.sprintEngineAgents) } : {}),
    ...(recordSummary(parsed.runSummary ?? parsed.summary) ? { runSummary: recordSummary(parsed.runSummary ?? parsed.summary) } : {}),
    ...(recordSummary(parsed.planReview ?? parsed.planReviewState) ? { planReview: recordSummary(parsed.planReview ?? parsed.planReviewState) } : {}),
  }
}

async function readSprintEngineProjectionSnapshot(
  statePath: string,
  teamDirectory: string
): Promise<MobileSprintEngineSnapshot | null> {
  let content: string
  try {
    content = await readFile(join(teamDirectory, 'projection.json'), 'utf8')
  } catch {
    return null
  }
  const projection = JSON.parse(content) as Record<string, unknown>
  const run = recordObject(projection.run) ?? {}
  const sprintEngineRootDirectory = dirname(teamDirectory)
  const workspacePath = dirname(dirname(sprintEngineRootDirectory))
  const sprintEngineId = stringOrNull(run.id) ?? basename(teamDirectory)
  const updatedAt = isoStringOrNull(projection.updatedAt) ?? isoStringOrNull(run.updatedAt) ?? new Date().toISOString()
  const tasks = normalizeTasks(projection.tasks)
  const taskSnapshots = tasks.map((task) => toTaskSnapshot(task, tasks))
  const artifacts = normalizeArtifacts(projection.artifacts)
  const board = countBoard(taskSnapshots)
  const locks = recordObject(projection.locks)
  const activity = Array.isArray(projection.activity) ? projection.activity : []
  const counts = recordObject(projection.counts)
  const snapshotVersion = buildSnapshotVersion({
    updatedAt,
    source: projection.source,
    tasks: taskSnapshots,
    artifacts,
    locks,
  })

  return {
    sprintEngineId,
    name: stringOrFallback(run.name, sprintEngineId),
    workspacePath,
    statePath,
    planPath: stringOrNull(projection.planPath) ?? join(teamDirectory, 'plan.md'),
    snapshotVersion,
    updatedAt,
    board,
    tasks: taskSnapshots,
    artifacts,
    ...(normalizeRoster(projection.roster) ? { roster: normalizeRoster(projection.roster) } : {}),
    ...(recordSummary(projection.runSummary) ? { runSummary: recordSummary(projection.runSummary) } : {}),
    ...(locks ? { locks: { warnings: Array.isArray(locks.warnings) ? locks.warnings : [], locks: Array.isArray(locks.locks) ? locks.locks : [] } } : {}),
    ...(activity.length > 0 ? { activity: { count: activity.length, latest: activity.at(-1) } } : {}),
    ...(counts ? { counts: { ready: numberOrUndefined(counts.ready), needsInput: numberOrUndefined(counts.needsInput) } } : {}),
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
      needsInput: normalizeNeedsInput(record.needsInput),
      evidence: normalizeEvidence(record.evidence),
      feedback: normalizeTaskFeedback(record.feedback),
      reviewSignals: normalizeReviewSignals(record),
      release: normalizeRelease(record.release ?? record.taskRelease),
    }]
  })
}

function toSprintEngineWorkspaceSnapshot(sprintEngine: MobileSprintEngineSnapshot): MobileWorkspaceSnapshot {
  return {
    workspaceId: sprintEngine.sprintEngineId,
    kind: 'sprintengine',
    name: sprintEngine.name,
    workspacePath: sprintEngine.workspacePath,
    statePath: sprintEngine.statePath,
    updatedAt: sprintEngine.updatedAt,
    capabilities: ['summary.read', 'detail.read', 'logs.read'],
    detailVersion: mobileControlWorkspaceSnapshotVersion,
    summary: {
      status: sprintEngineWorkspaceStatus(sprintEngine),
      headline: `${sprintEngine.board.ready} ready, ${sprintEngine.board.needsInput} needs input`,
      counts: {
        todo: sprintEngine.board.todo,
        ready: sprintEngine.board.ready,
        inProgress: sprintEngine.board.inProgress,
        needsInput: sprintEngine.board.needsInput,
        blocked: sprintEngine.board.blocked,
        done: sprintEngine.board.done,
      },
    },
    detail: {
      kind: 'sprintengine',
      data: {
        sprintEngineId: sprintEngine.sprintEngineId,
        snapshotVersion: sprintEngine.snapshotVersion,
        board: sprintEngine.board,
        ...(sprintEngine.roster ? { roster: sprintEngine.roster } : {}),
        ...(sprintEngine.runSummary ? { runSummary: sprintEngine.runSummary } : {}),
        ...(sprintEngine.planReview ? { planReview: sprintEngine.planReview } : {}),
      },
    },
  }
}

function sprintEngineWorkspaceStatus(sprintEngine: MobileSprintEngineSnapshot): MobileWorkspaceStatus {
  if (sprintEngine.board.needsInput > 0) return 'needs_input'
  if (sprintEngine.board.blocked > 0) return 'blocked'
  if (sprintEngine.board.inProgress > 0) return 'running'
  if (sprintEngine.board.ready > 0 || sprintEngine.board.todo > 0) return 'idle'
  if (sprintEngine.board.done > 0) return 'complete'
  return 'unknown'
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
    ...(task.needsInput ? { needsInput: task.needsInput } : {}),
    ...(task.evidence ? { evidence: task.evidence } : {}),
    ...(task.feedback ? { feedback: task.feedback } : {}),
    ...(task.reviewSignals ? { reviewSignals: task.reviewSignals } : {}),
    ...(task.release ? { release: task.release } : {}),
  }
}

function getMobileTaskStatus(task: NormalizedTask, tasks: NormalizedTask[]): MobileTaskStatus {
  if (task.status === 'ready' || task.status === 'done' || task.status === 'in_progress' || task.status === 'needs_input') {
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

function normalizeMobileControlCommands(commands: readonly MobileControlCommandType[]): MobileControlCommandType[] {
  const supported = new Set<MobileControlCommandType>()
  for (const command of commands) {
    if (mobileSnapshotCommandTypes.includes(command)) {
      supported.add(command)
    }
  }
  return [...supported]
}

async function readSwitchboardWorkspaceSnapshot(
  workspaceRoot: string,
  generatedAt: string,
  readers: Pick<DesktopWorkspaceStateReaders, 'readSwitchboardTasks' | 'getSwitchboardRunnerState'>
): Promise<MobileWorkspaceSnapshot | null> {
  const tasksResult = await readers.readSwitchboardTasks({ workspaceRoot })
  if (!tasksResult.ok) return null

  const runnerResult = await readers.getSwitchboardRunnerState(workspaceRoot).catch((): SwitchboardRunnerResult => ({
    ok: false,
    message: 'Switchboard runner state is unavailable.',
  }))
  const laneCounts = countSwitchboardLanes(tasksResult.tasks)
  const inboxCount = laneCounts.inbox ?? 0
  const activeExecutionCount = runnerResult.ok ? runnerResult.activeExecutions.length : 0
  const sortedTasks = sortSwitchboardRecords(tasksResult.tasks)
  const taskSummaries = sortedTasks
    .filter((record) => record.location.folderStatus !== 'inbox')
    .slice(0, maxWorkspaceCollectionItems)
    .map(toSwitchboardTaskSummary)
  const inboxItems = sortedTasks
    .filter((record) => record.location.folderStatus === 'inbox')
    .slice(0, maxWorkspaceCollectionItems)
    .map(toSwitchboardTaskSummary)
  const comments = sortedTasks.flatMap(toSwitchboardCommentSummaries).slice(0, maxWorkspaceCollectionItems)
  const evidence = sortedTasks.flatMap(toSwitchboardEvidenceSummary).slice(0, maxWorkspaceCollectionItems)
  const logs = [
    ...sortedTasks.flatMap(toSwitchboardLogSummaries),
    ...(runnerResult.ok ? runnerResult.activeExecutions.map(toActiveSwitchboardExecutionLogSummary) : []),
  ].slice(0, maxWorkspaceCollectionItems)
  if (tasksResult.tasks.length === 0 && tasksResult.problems.length === 0 && activeExecutionCount === 0) {
    return null
  }
  const updatedAt = latestIso([
    generatedAt,
    ...tasksResult.tasks.map((record) => record.task.updatedAt),
    ...(runnerResult.ok && runnerResult.updatedAt ? [runnerResult.updatedAt] : []),
  ])

  return {
    workspaceId: `switchboard:${workspaceRoot}`,
    kind: 'switchboard',
    name: 'Switchboard',
    workspacePath: workspaceRoot,
    statePath: tasksResult.switchboardRoot,
    updatedAt,
    capabilities: ['summary.read', 'detail.read'],
    detailVersion: mobileControlWorkspaceSnapshotVersion,
    summary: {
      status: switchboardWorkspaceStatus(activeExecutionCount, tasksResult.problems.length),
      headline: `${inboxCount} inbox, ${activeExecutionCount} active`,
      counts: {
        ...laneCounts,
        activeExecutions: activeExecutionCount,
        problems: tasksResult.problems.length,
      },
    },
    detail: {
      kind: 'switchboard',
      data: {
        inboxCount,
        laneCounts,
        activeExecutionCount,
        tasks: taskSummaries,
        inboxItems,
        comments,
        evidence,
        logs,
      },
    },
  }
}

async function readWatchtowerWorkspaceSnapshot(
  workspaceRoot: string,
  generatedAt: string,
  readers: Pick<DesktopWorkspaceStateReaders, 'listWatchtowerRuns'>
): Promise<MobileWorkspaceSnapshot | null> {
  const runsResult = await readers.listWatchtowerRuns(workspaceRoot)
  if (!runsResult.ok || runsResult.runs.length === 0) return null

  const sortedRuns = [...runsResult.runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const latestRun = sortedRuns[0]
  const activeRunCount = runsResult.runs.filter((run) => run.status === 'pending' || run.status === 'running').length
  const generatedInboxCount = runsResult.runs.reduce((count, run) => count + run.counts.ingested, 0)
  const runs = sortedRuns.slice(0, maxWorkspaceCollectionItems).map(toWatchtowerRunSummary)
  const generatedInboxItems = sortedRuns
    .flatMap((run) => run.agents.flatMap((agent) => (agent.taskIds ?? []).map((taskId): MobileWatchtowerGeneratedInboxSummary => ({
      runId: run.runId,
      taskId,
      source: 'watchtower',
    }))))
    .slice(0, maxWorkspaceCollectionItems)

  return {
    workspaceId: `watchtower:${workspaceRoot}`,
    kind: 'watchtower',
    name: 'Watchtower',
    workspacePath: workspaceRoot,
    updatedAt: latestIso([generatedAt, ...runsResult.runs.map((run) => run.completedAt ?? run.createdAt)]),
    capabilities: ['summary.read', 'detail.read'],
    detailVersion: mobileControlWorkspaceSnapshotVersion,
    summary: {
      status: watchtowerWorkspaceStatus(runsResult.runs),
      headline: `${activeRunCount} active, ${generatedInboxCount} generated inbox items`,
      counts: {
        activeRuns: activeRunCount,
        generatedInboxItems: generatedInboxCount,
        problems: runsResult.problems?.length ?? 0,
      },
    },
    detail: {
      kind: 'watchtower',
      data: {
        activeRunCount,
        latestRunStatus: latestRun.status,
        generatedInboxCount,
        runs,
        generatedInboxItems,
      },
    },
  }
}

async function readMultiloopWorkspaceSnapshots(workspaceRoot: string): Promise<MobileWorkspaceSnapshot[]> {
  const multiloopRoot = join(workspaceRoot, 'multiloop')
  let entries
  try {
    entries = await readdir(multiloopRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const settled = await Promise.allSettled(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readMultiloopWorkspaceSnapshot(workspaceRoot, join(multiloopRoot, entry.name, 'state.json')))
  )
  return settled.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : [])
}

async function readMultiloopWorkspaceSnapshot(workspaceRoot: string, statePath: string): Promise<MobileWorkspaceSnapshot | null> {
  const [content, stateStats] = await Promise.all([
    readFile(statePath, 'utf8'),
    stat(statePath),
  ])
  const state = JSON.parse(content) as unknown
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null
  const record = state as Record<string, unknown>
  const loop = recordObject(record.loop)
  if (!loop) return null

  const loopId = stringOrFallback(loop.name, basename(dirname(statePath)))
  const displayName = stringOrFallback(loop.displayName, loopId)
  const roadmap = Array.isArray(record.roadmap) ? record.roadmap.filter(isRecord) : []
  const blockers = Array.isArray(record.blockers) ? record.blockers.filter(isRecord) : []
  const activeBlockers = blockers.filter((blocker) => blocker.status !== 'resolved').length
  const linkedSprintEngineId = roadmap
    .map((milestone) => recordObject(milestone.sprintEngine))
    .map((link) => stringOrNull(link?.teamSlug))
    .find((teamSlug): teamSlug is string => Boolean(teamSlug))

  return {
    workspaceId: `multiloop:${loopId}`,
    kind: 'multiloop',
    name: displayName,
    workspacePath: workspaceRoot,
    statePath,
    updatedAt: isoStringOrNull(loop.updatedAt) ?? stateStats.mtime.toISOString(),
    capabilities: ['summary.read', 'detail.read'],
    detailVersion: mobileControlWorkspaceSnapshotVersion,
    summary: {
      status: multiloopWorkspaceStatus(loop.status, activeBlockers),
      headline: `${roadmap.length} milestones, ${activeBlockers} blockers`,
      counts: {
        milestones: roadmap.length,
        blockers: activeBlockers,
      },
    },
    detail: {
      kind: 'multiloop',
      data: {
        loopId,
        milestoneCount: roadmap.length,
        blockerCount: activeBlockers,
        ...(linkedSprintEngineId ? { linkedSprintEngineId } : {}),
        milestones: roadmap.slice(0, maxWorkspaceCollectionItems).map((milestone, index) => toMultiloopMilestoneSummary(milestone, index)),
        blockers: blockers.slice(0, maxWorkspaceCollectionItems).map((blocker, index) => toMultiloopBlockerSummary(blocker, index)),
      },
    },
  }
}

function sortSwitchboardRecords(records: SwitchboardTaskRecord[]): SwitchboardTaskRecord[] {
  return [...records].sort((a, b) => Date.parse(b.task.updatedAt) - Date.parse(a.task.updatedAt))
}

function toSwitchboardTaskSummary(record: SwitchboardTaskRecord): MobileSwitchboardTaskSummary {
  return {
    taskId: record.task.id,
    identifier: record.task.identifier,
    title: record.task.title,
    status: record.task.state,
    lane: record.location.folderStatus,
    updatedAt: record.task.updatedAt,
    source: {
      type: record.task.source.type,
      ...(record.task.source.externalId ? { externalId: record.task.source.externalId } : {}),
      ...(record.task.source.externalKey ? { externalKey: record.task.source.externalKey } : {}),
      ...(record.task.source.externalUrl ? { externalUrl: record.task.source.externalUrl } : {}),
    },
    ...(record.task.priority !== undefined ? { priority: record.task.priority } : {}),
    ...(record.task.claim?.owner ? { claimedBy: record.task.claim.owner } : {}),
  }
}

function toSwitchboardCommentSummaries(record: SwitchboardTaskRecord): MobileSwitchboardCommentSummary[] {
  return [...record.task.comments]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, maxNestedWorkspaceCollectionItems)
    .map((comment) => ({
      taskId: record.task.id,
      commentId: comment.id,
      kind: comment.kind,
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.author.name !== undefined ? { authorName: comment.author.name } : {}),
      ...(comment.confidencePct !== undefined ? { confidencePct: comment.confidencePct } : {}),
    }))
}

function toSwitchboardEvidenceSummary(record: SwitchboardTaskRecord): MobileSwitchboardEvidenceSummary[] {
  const evidence = record.task.evidence
  if (
    !evidence.summary
    && evidence.artifacts.length === 0
    && evidence.commandsRun.length === 0
    && evidence.touchedFiles.length === 0
  ) {
    return []
  }
  return [{
    taskId: record.task.id,
    ...(evidence.summary ? { summary: evidence.summary } : {}),
    artifactCount: evidence.artifacts.length,
    commandCount: evidence.commandsRun.length,
    touchedFileCount: evidence.touchedFiles.length,
    updatedAt: record.task.updatedAt,
  }]
}

function toSwitchboardLogSummaries(record: SwitchboardTaskRecord): MobileSwitchboardLogSummary[] {
  return [...record.task.execution.attempts]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, maxNestedWorkspaceCollectionItems)
    .map((attempt) => ({
      taskId: record.task.id,
      executionId: attempt.id,
      agentId: attempt.agentId ?? null,
      status: attempt.completedAt ? 'completed' : 'running',
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt ?? null,
      summary: attempt.summary ?? null,
    }))
}

function toActiveSwitchboardExecutionLogSummary(execution: SwitchboardRunnerExecution): MobileSwitchboardLogSummary {
  return {
    ...(execution.kind === 'switchboard_task' ? { taskId: execution.taskId } : {}),
    executionId: execution.executionId,
    status: execution.status ?? 'active',
    agentId: execution.role,
    startedAt: execution.startedAt,
    summary: execution.kind,
  }
}

function toWatchtowerRunSummary(run: WatchtowerRun): MobileWatchtowerRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    preset: run.preset,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    validCount: run.counts.valid,
    invalidCount: run.counts.invalid,
    generatedInboxCount: run.counts.ingested,
    agentCount: run.agents.length,
  }
}

function toMultiloopMilestoneSummary(milestone: Record<string, unknown>, index: number): MobileMultiloopMilestoneSummary {
  const sprintEngine = recordObject(milestone.sprintEngine)
  return {
    milestoneId: stringOrNull(milestone.id) ?? stringOrNull(milestone.slug) ?? stringOrNull(milestone.name) ?? `milestone-${index + 1}`,
    title: stringOrNull(milestone.title) ?? stringOrNull(milestone.displayName) ?? stringOrNull(milestone.name) ?? `Milestone ${index + 1}`,
    ...(stringOrNull(milestone.status) ? { status: stringOrNull(milestone.status) as string } : {}),
    ...(isoStringOrNull(milestone.updatedAt) ? { updatedAt: isoStringOrNull(milestone.updatedAt) as string } : {}),
    ...(stringOrNull(sprintEngine?.teamSlug) ? { linkedSprintEngineId: stringOrNull(sprintEngine?.teamSlug) as string } : {}),
  }
}

function toMultiloopBlockerSummary(blocker: Record<string, unknown>, index: number): MobileMultiloopBlockerSummary {
  return {
    blockerId: stringOrNull(blocker.id) ?? stringOrNull(blocker.slug) ?? stringOrNull(blocker.title) ?? `blocker-${index + 1}`,
    title: stringOrNull(blocker.title) ?? stringOrNull(blocker.summary) ?? stringOrNull(blocker.name) ?? `Blocker ${index + 1}`,
    ...(stringOrNull(blocker.status) ? { status: stringOrNull(blocker.status) as string } : {}),
    ...(isoStringOrNull(blocker.updatedAt) ? { updatedAt: isoStringOrNull(blocker.updatedAt) as string } : {}),
  }
}

function countSwitchboardLanes(records: SwitchboardTaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    const lane = record.location.folderStatus
    counts[lane] = (counts[lane] ?? 0) + 1
  }
  return counts
}

function switchboardWorkspaceStatus(activeExecutionCount: number, problemCount: number): MobileWorkspaceStatus {
  if (problemCount > 0) return 'error'
  if (activeExecutionCount > 0) return 'running'
  return 'idle'
}

function watchtowerWorkspaceStatus(runs: WatchtowerRun[]): MobileWorkspaceStatus {
  if (runs.some((run) => run.status === 'failed')) return 'error'
  if (runs.some((run) => run.status === 'running' || run.status === 'pending')) return 'running'
  if (runs.length > 0) return 'complete'
  return 'idle'
}

function multiloopWorkspaceStatus(status: unknown, activeBlockers: number): MobileWorkspaceStatus {
  if (status === 'accepted') return 'complete'
  if (status === 'blocked' || activeBlockers > 0) return 'blocked'
  if (status === 'active') return 'running'
  return 'unknown'
}

function normalizeNeedsInput(value: unknown): NormalizedTask['needsInput'] | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const normalized = {
    kind: stringOrNull(record.kind) ?? undefined,
    reason: stringOrNull(record.reason) ?? undefined,
    question: stringOrNull(record.question) ?? undefined,
    suggestedResolution: stringOrNull(record.suggestedResolution) ?? undefined,
    artifactId: stringOrNull(record.artifactId) ?? undefined,
  }
  return Object.values(normalized).some(Boolean) ? normalized : undefined
}

function normalizeEvidence(value: unknown): NormalizedTask['evidence'] | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const summary = stringOrNull(record.summary) ?? undefined
  const touchedFileCount = arrayLength(record.touchedFiles)
  const commandCount = arrayLength(record.commandsRan)
  const resultCount = arrayLength(record.results)
  if (!summary && touchedFileCount === 0 && commandCount === 0 && resultCount === 0) return undefined
  return { summary, touchedFileCount, commandCount, resultCount }
}

function normalizeTaskFeedback(value: unknown): NormalizedTask['feedback'] | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const confidencePct = numberOrUndefined(record.confidencePct)
  const hallucinationRiskPct = numberOrUndefined(record.hallucinationRiskPct)
  return confidencePct === undefined && hallucinationRiskPct === undefined
    ? undefined
    : { confidencePct, hallucinationRiskPct }
}

function normalizeReviewSignals(record: Record<string, unknown>): NormalizedTask['reviewSignals'] | undefined {
  const findings = arrayLength(record.findings)
  const issues = arrayLength(record.issues)
  const verdict = stringOrNull(record.verdict) ?? stringOrNull(record.reviewVerdict) ?? undefined
  if (findings === 0 && issues === 0 && !verdict) return undefined
  return { findingCount: findings, issueCount: issues, verdict }
}

function normalizeRelease(value: unknown): NormalizedTask['release'] | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const release = {
    requestedBy: stringOrNull(record.requestedBy) ?? stringOrNull(record.actor) ?? undefined,
    reason: stringOrNull(record.reason) ?? undefined,
  }
  return Object.values(release).some(Boolean) ? release : undefined
}

function normalizeRoster(value: unknown): MobileSprintEngineSnapshot['roster'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const roster: NonNullable<MobileSprintEngineSnapshot['roster']> = {}
  for (const [agentId, rawAgent] of Object.entries(value)) {
    const agent = recordObject(rawAgent)
    if (!agent) continue
    roster[agentId] = {
      role: stringOrNull(agent.role) ?? undefined,
      status: stringOrNull(agent.status) ?? undefined,
      currentTaskId: stringOrNull(agent.currentTaskId),
    }
  }
  return Object.keys(roster).length > 0 ? roster : undefined
}

function recordSummary(value: unknown): Record<string, string | number | boolean | null> | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const summary: Record<string, string | number | boolean | null> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      summary[key] = entry
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined
}

function normalizeTaskStatus(value: unknown): SprintEngineTaskStatus {
  if (value === 'ready' || value === 'in_progress' || value === 'needs_input' || value === 'done') return value
  if (value === 'changes_requested') return 'ready'
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

function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim()).map((path) => resolve(path)))]
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

function latestIso(values: Array<string | null | undefined>): string {
  const timestamps = values
    .flatMap((value) => value && Number.isFinite(Date.parse(value)) ? [value] : [])
    .sort((a, b) => Date.parse(b) - Date.parse(a))
  return timestamps[0] ?? new Date(0).toISOString()
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(recordObject(value))
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
