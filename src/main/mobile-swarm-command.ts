import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { access, readFile, stat } from 'fs/promises'
import { constants } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { readSwarmSnapshot } from './mobile-swarm-snapshot'

export const mobileControlProtocolVersion = 1 as const

export type MobileControlCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'swarm.create'
  | 'task.start'
  | 'artifact.approve'
  | 'artifact.requestChanges'
  | 'agent.followUp'
  | 'device.revoke'

type MobileControlErrorCode =
  | 'unsupported_protocol_version'
  | 'invalid_payload'
  | 'unauthenticated'
  | 'unauthorized'
  | 'device_revoked'
  | 'desktop_unavailable'
  | 'relay_unavailable'
  | 'command_not_supported'
  | 'command_expired'
  | 'duplicate_idempotency_key'
  | 'stale_snapshot'
  | 'swarm_not_found'
  | 'task_not_ready'
  | 'artifact_not_found'
  | 'path_not_allowed'
  | 'python_tool_failed'
  | 'internal_error'

export type MobileControlError = {
  protocolVersion: typeof mobileControlProtocolVersion
  code: MobileControlErrorCode
  message: string
  retryable: boolean
  correlationId?: string
  detail?: Record<string, string | number | boolean | null>
}

type MobileControlCommandBase<Type extends MobileControlCommandType, Payload> = {
  protocolVersion: typeof mobileControlProtocolVersion
  commandId: string
  type: Type
  issuedAt: string
  deviceId: string
  idempotencyKey?: string
  expectedSnapshotVersion?: string
  payload: Payload
}

type SwarmCreateCommand = MobileControlCommandBase<
  'swarm.create',
  {
    workspacePath: string
    productPrompt: string
    requestedRole?: string
  }
>

type TaskStartCommand = MobileControlCommandBase<
  'task.start',
  {
    swarmId: string
    taskId: string
    role: string
    worktreeIsolation?: MobileTaskStartWorktreeIsolation
  }
>

type AgentFollowUpCommand = MobileControlCommandBase<
  'agent.followUp',
  {
    swarmId: string
    agentId: string
    text: string
  }
>

type ArtifactApproveCommand = MobileControlCommandBase<
  'artifact.approve',
  {
    swarmId: string
    artifactId: string
    feedback?: string
  }
>

type ArtifactRequestChangesCommand = MobileControlCommandBase<
  'artifact.requestChanges',
  {
    swarmId: string
    artifactId: string
    feedback: string
  }
>

type UnsupportedMobileControlCommand = MobileControlCommandBase<
  Exclude<MobileControlCommandType, 'swarm.create' | 'task.start' | 'agent.followUp' | 'artifact.approve' | 'artifact.requestChanges'>,
  Record<string, unknown>
>

export type MobileControlCommand =
  | SwarmCreateCommand
  | TaskStartCommand
  | AgentFollowUpCommand
  | ArtifactApproveCommand
  | ArtifactRequestChangesCommand
  | UnsupportedMobileControlCommand

export type MobileTaskStartWorktreeIsolation = 'preferred' | 'required' | 'disabled'

export type MobileSwarmTaskStartRequest = {
  swarmId: string
  statePath: string
  teamDirectory: string
  workspaceRoot: string
  taskId: string
  role: string
  deviceId: string
  commandId: string
  worktreeIsolation: MobileTaskStartWorktreeIsolation
}

export type MobileSwarmTaskStartResult = {
  sessionId: string
  agentId: string
  executionMode: 'current_workspace' | 'worktree'
  worktreeId?: string
  worktreePath?: string
}

export type MobileSwarmFollowUpRequest = {
  swarmId: string
  statePath: string
  teamDirectory: string
  workspaceRoot: string
  agentId: string
  text: string
  deviceId: string
  commandId: string
}

export type MobileSwarmFollowUpResult = {
  sessionId: string
  agentId: string
  acceptedAt: string
}

export type MobileSwarmSessionOrchestrator = {
  startTask(request: MobileSwarmTaskStartRequest): Promise<MobileSwarmTaskStartResult>
  sendFollowUp(request: MobileSwarmFollowUpRequest): Promise<MobileSwarmFollowUpResult>
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MobileControlError }

const defaultCommandTtlMs = 30_000
const maxRememberedIdempotencyKeys = 500
const maxProductPromptCharacters = 20_000
const maxFeedbackCharacters = 8_000
const maxFollowUpCharacters = 2_000
const allowedCommandTypes = new Set<MobileControlCommandType>([
  'swarm.create',
  'task.start',
  'agent.followUp',
  'artifact.approve',
  'artifact.requestChanges',
])
const commandTypes = new Set<MobileControlCommandType>([
  'snapshot.request',
  'artifact.read',
  'swarm.create',
  'task.start',
  'artifact.approve',
  'artifact.requestChanges',
  'agent.followUp',
  'device.revoke',
])

type SwarmToolInvocation = {
  args: string[]
  cwd: string
}

type SwarmToolExecutionResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

type SwarmToolExecutor = (invocation: SwarmToolInvocation) => Promise<SwarmToolExecutionResult>

type MobileSwarmCommandServiceOptions = {
  workspaceRoot?: string
  allowedWorkspaceRoots?: string[]
  statePaths?: string[]
  swarmToolPath?: string
  commandTtlMs?: number
  now?: () => Date
  execute?: SwarmToolExecutor
  sessionOrchestrator?: MobileSwarmSessionOrchestrator
  auditSink?: (entry: MobileSwarmCommandAuditEntry) => void
}

type MobileSwarmCommandAuditStatus = 'accepted' | 'rejected' | 'failed'

type CachedMobileSwarmCommandResult = {
  requestHash: string
  result: MobileSwarmCommandResult
}

export type MobileSwarmCommandAuditEntry = {
  auditId: string
  commandId: string
  commandType: MobileControlCommandType | 'unknown'
  deviceId: string | null
  idempotencyKey?: string
  status: MobileSwarmCommandAuditStatus
  code?: MobileControlError['code']
  message: string
  recordedAt: string
  statePath?: string
  artifactId?: string
  workspacePath?: string
  toolArgs?: string[]
  exitCode?: number | null
}

export type MobileSwarmCommandResult =
  | {
      ok: true
      commandId: string
      commandType: MobileControlCommandType
      idempotencyKey?: string
      executedAt: string
      data: unknown
      stdout: string
      stderr: string
      audit: MobileSwarmCommandAuditEntry
    }
  | {
      ok: false
      commandId: string | null
      commandType: MobileControlCommandType | 'unknown'
      idempotencyKey?: string
      error: MobileControlError
      audit: MobileSwarmCommandAuditEntry
    }

type ValidSwarmStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

type SwarmArtifactRecord = {
  id: string
  path?: string
}

type SwarmTaskRecord = {
  id: string
  role: string
  status: 'todo' | 'in_progress' | 'needs_input' | 'done'
  ownerAgentId: string | null
  dependsOn: string[]
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

const idempotencyResults = new Map<string, CachedMobileSwarmCommandResult>()

export class MobileSwarmCommandService {
  private readonly workspaceRoot: string
  private readonly allowedWorkspaceRoots: string[]
  private readonly statePaths: string[]
  private readonly commandTtlMs: number
  private readonly now: () => Date
  private readonly execute: SwarmToolExecutor
  private readonly sessionOrchestrator?: MobileSwarmSessionOrchestrator
  private readonly auditSink?: (entry: MobileSwarmCommandAuditEntry) => void
  private readonly auditLog: MobileSwarmCommandAuditEntry[] = []

  constructor(options: MobileSwarmCommandServiceOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
    this.allowedWorkspaceRoots = uniqueResolved([
      this.workspaceRoot,
      ...(options.allowedWorkspaceRoots ?? []),
    ])
    this.statePaths = (options.statePaths ?? []).map((statePath) => validateSwarmStatePath(statePath).statePath)
    this.commandTtlMs = Math.max(1, options.commandTtlMs ?? defaultCommandTtlMs)
    this.now = options.now ?? (() => new Date())
    this.execute = options.execute ?? createSwarmToolExecutor(options.swarmToolPath ?? defaultSwarmToolPath())
    this.sessionOrchestrator = options.sessionOrchestrator
    this.auditSink = options.auditSink
  }

  getAuditLog(): MobileSwarmCommandAuditEntry[] {
    return [...this.auditLog]
  }

  async dispatch(input: unknown): Promise<MobileSwarmCommandResult> {
    const validated = validateMobileControlCommand(input)
    if (!validated.ok) {
      return this.rejectUnknown(validated.error)
    }

    const command = validated.value
    if (!allowedCommandTypes.has(command.type)) {
      return this.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the swarm command service.`, false)
    }

    if (!command.idempotencyKey) {
      return this.reject(command, 'invalid_payload', 'idempotencyKey is required for swarm mutation commands.', false)
    }

    const idempotencyKey = this.idempotencyKeyFor(command)
    const requestHash = requestHashFor(command)
    const cachedResult = this.replayCachedResult(command, idempotencyKey, requestHash)
    if (cachedResult) {
      return cachedResult
    }

    const ttlError = this.validateCommandTtl(command)
    if (ttlError) {
      return this.reject(command, 'command_expired', ttlError, false)
    }

    try {
      const result = await this.executeCommand(command)
      this.rememberIdempotencyResult(idempotencyKey, requestHash, result)
      return result
    } catch (error) {
      if (error instanceof MobileSwarmCommandError) {
        const result = this.reject(command, error.code, error.message, error.retryable)
        this.rememberIdempotencyResult(idempotencyKey, requestHash, result)
        return result
      }
      const result = this.reject(command, 'internal_error', getErrorMessage(error), false)
      this.rememberIdempotencyResult(idempotencyKey, requestHash, result)
      return result
    }
  }

  private async executeCommand(command: MobileControlCommand): Promise<MobileSwarmCommandResult> {
    switch (command.type) {
      case 'artifact.approve':
        return this.executeArtifactReviewCommand(command, 'approve')
      case 'artifact.requestChanges':
        return this.executeArtifactReviewCommand(command, 'request-changes')
      case 'swarm.create':
        return this.executeSwarmCreateCommand(command)
      case 'task.start':
        return this.executeTaskStartCommand(command)
      case 'agent.followUp':
        return this.executeAgentFollowUpCommand(command)
      case 'snapshot.request':
      case 'artifact.read':
      case 'device.revoke':
        return this.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the swarm command service.`, false)
    }
  }

  private async executeTaskStartCommand(
    command: Extract<MobileControlCommand, { type: 'task.start' }>
  ): Promise<MobileSwarmCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile task starts.', false)
    }

    const state = await this.resolveStateForSwarm(command.payload.swarmId)
    await this.assertExpectedSnapshotVersion(command, state.statePath)
    const task = await this.findReadyTask(state, command.payload.taskId, command.payload.role)
    const worktreeIsolation = normalizeWorktreeIsolation(command.payload.worktreeIsolation)

    const data = await this.sessionOrchestrator.startTask({
      swarmId: command.payload.swarmId,
      statePath: state.statePath,
      teamDirectory: state.teamDirectory,
      workspaceRoot: state.workspaceRoot,
      taskId: task.id,
      role: task.role,
      deviceId: command.deviceId,
      commandId: command.commandId,
      worktreeIsolation,
    })

    return this.acceptSessionCommand(
      command,
      data,
      state,
      'Mobile task start was accepted by desktop session orchestration.'
    )
  }

  private async executeAgentFollowUpCommand(
    command: Extract<MobileControlCommand, { type: 'agent.followUp' }>
  ): Promise<MobileSwarmCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile follow-up messages.', false)
    }

    const state = await this.resolveStateForSwarm(command.payload.swarmId)
    await this.assertExpectedSnapshotVersion(command, state.statePath)
    const text = normalizeFollowUpText(command.payload.text)
    await this.assertKnownActiveAgent(state, command.payload.agentId)

    const data = await this.sessionOrchestrator.sendFollowUp({
      swarmId: command.payload.swarmId,
      statePath: state.statePath,
      teamDirectory: state.teamDirectory,
      workspaceRoot: state.workspaceRoot,
      agentId: command.payload.agentId,
      text,
      deviceId: command.deviceId,
      commandId: command.commandId,
    })

    return this.acceptSessionCommand(
      command,
      data,
      state,
      'Mobile follow-up was accepted by desktop session orchestration.'
    )
  }

  private async executeArtifactReviewCommand(
    command: Extract<MobileControlCommand, { type: 'artifact.approve' | 'artifact.requestChanges' }>,
    action: 'approve' | 'request-changes'
  ): Promise<MobileSwarmCommandResult> {
    const state = await this.resolveStateForSwarm(command.payload.swarmId)
    await this.assertExpectedSnapshotVersion(command, state.statePath)
    const artifact = await this.findArtifact(state, command.payload.artifactId)

    const actorId = mobileActorId(command.deviceId)
    const args = [
      '--state',
      state.statePath,
      'artifact',
      action,
      '--artifact-id',
      artifact.id,
      '--id',
      actorId,
    ]

    if (action === 'request-changes') {
      const feedback = typeof command.payload.feedback === 'string' ? command.payload.feedback.trim() : ''
      if (!feedback) {
        return this.reject(command, 'invalid_payload', 'Artifact change requests require feedback.', false, state, artifact.id)
      }
      if (feedback.length > maxFeedbackCharacters) {
        return this.reject(command, 'invalid_payload', `Artifact feedback must be ${maxFeedbackCharacters} characters or less.`, false, state, artifact.id)
      }
      args.push('--feedback', feedback)
    }

    return this.invokeTool(command, args, state.workspaceRoot, state, artifact.id)
  }

  private async executeSwarmCreateCommand(
    command: Extract<MobileControlCommand, { type: 'swarm.create' }>
  ): Promise<MobileSwarmCommandResult> {
    const workspacePath = await this.validateWorkspacePath(command.payload.workspacePath)
    const productPrompt = command.payload.productPrompt.trim()
    if (!productPrompt) {
      return this.reject(command, 'invalid_payload', 'Swarm creation requires a product prompt.', false, undefined, undefined, workspacePath)
    }
    if (productPrompt.length > maxProductPromptCharacters) {
      return this.reject(command, 'invalid_payload', `Product prompt must be ${maxProductPromptCharacters} characters or less.`, false, undefined, undefined, workspacePath)
    }

    const teamName = `mobile-${safeSlug(command.commandId)}`
    const args = [
      'handover',
      '--name',
      teamName,
      '--goal',
      productPrompt,
      '--handover-text',
      productPrompt,
      '--actor',
      mobileActorId(command.deviceId),
    ]

    return this.invokeTool(command, args, workspacePath, undefined, undefined, workspacePath)
  }

  private async resolveStateForSwarm(swarmId: string): Promise<ValidSwarmStatePath> {
    if (!isSafePathSegment(swarmId)) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Swarm id must be a single safe path segment.', false)
    }

    const statePath = this.statePaths.length > 0
      ? this.statePaths.find((candidate) => basename(dirname(candidate)) === swarmId)
      : join(this.workspaceRoot, 'swarm', swarmId, 'state.yaml')

    if (!statePath) {
      throw new MobileSwarmCommandError('swarm_not_found', 'Requested swarm is not available to mobile control.', false)
    }

    const state = validateSwarmStatePath(statePath)
    if (!this.isAllowedWorkspace(state.workspaceRoot)) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Swarm state path is outside the allowed workspace roots.', false)
    }

    try {
      const stateStats = await stat(state.statePath)
      if (!stateStats.isFile()) {
        throw new MobileSwarmCommandError('swarm_not_found', 'Swarm state path is not a file.', false)
      }
    } catch (error) {
      if (error instanceof MobileSwarmCommandError) throw error
      throw new MobileSwarmCommandError('swarm_not_found', 'Requested swarm state was not found.', false)
    }

    return state
  }

  private async findArtifact(state: ValidSwarmStatePath, artifactId: string): Promise<SwarmArtifactRecord> {
    const parsed = await this.readRawState(state)
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
      throw new MobileSwarmCommandError('artifact_not_found', 'Requested artifact was not found in the swarm state.', false)
    }

    if (artifact.path) {
      this.resolveArtifactFilePath(state, artifact.path)
    }

    return artifact
  }

  private async findReadyTask(state: ValidSwarmStatePath, taskId: string, role: string): Promise<SwarmTaskRecord> {
    const parsed = await this.readRawState(state)
    const tasks = normalizeSwarmTasks(parsed.tasks)
    const task = tasks.find((candidate) => candidate.id === taskId)
    if (!task) {
      throw new MobileSwarmCommandError('task_not_ready', 'Requested task was not found in the swarm state.', false)
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

  private async assertKnownActiveAgent(state: ValidSwarmStatePath, agentId: string): Promise<void> {
    const parsed = await this.readRawState(state)
    const swarmAgents = parsed.swarmAgents && typeof parsed.swarmAgents === 'object' ? parsed.swarmAgents : {}
    const agent = swarmAgents[agentId]
    if (agent?.status === 'done') {
      throw new MobileSwarmCommandError('task_not_ready', 'Follow-up target agent is already done.', false)
    }
    if (agent) return

    const ownedTask = normalizeSwarmTasks(parsed.tasks).find((task) => task.ownerAgentId === agentId)
    if (!ownedTask || ownedTask.status === 'done') {
      throw new MobileSwarmCommandError('task_not_ready', 'Follow-up target agent is not active in this swarm.', false)
    }
  }

  private async readRawState(state: ValidSwarmStatePath): Promise<RawSwarmState> {
    return JSON.parse(await readFile(state.statePath, 'utf8')) as RawSwarmState
  }

  private resolveArtifactFilePath(state: ValidSwarmStatePath, artifactPathInput: string): string {
    const artifactPath = artifactPathInput.trim()
    if (!artifactPath) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Artifact path is required.', false)
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(artifactPath)) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Artifact path must be a workspace file path.', false)
    }

    const fullPath = isAbsolute(artifactPath)
      ? resolve(artifactPath)
      : [
          resolve(state.workspaceRoot, artifactPath),
          resolve(state.teamDirectory, artifactPath),
        ].find((candidate) => isPathInsideOrEqual(state.teamDirectory, candidate))
          ?? resolve(state.workspaceRoot, artifactPath)

    if (!isPathInsideOrEqual(state.teamDirectory, fullPath)) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Artifact path must stay inside the swarm team directory.', false)
    }

    return fullPath
  }

  private async assertExpectedSnapshotVersion(command: MobileControlCommand, statePath: string): Promise<void> {
    if (!command.expectedSnapshotVersion) return
    const snapshot = await readSwarmSnapshot(statePath)
    if (snapshot.snapshotVersion !== command.expectedSnapshotVersion) {
      throw new MobileSwarmCommandError('stale_snapshot', 'Command was based on a stale swarm snapshot.', false)
    }
  }

  private async validateWorkspacePath(input: string): Promise<string> {
    if (!isAbsolute(input)) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Workspace path must be absolute.', false)
    }

    const workspacePath = resolve(input)
    if (!this.isAllowedWorkspace(workspacePath)) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Workspace path is outside the allowed workspace roots.', false)
    }

    try {
      await access(workspacePath, constants.R_OK | constants.W_OK)
      const workspaceStats = await stat(workspacePath)
      if (!workspaceStats.isDirectory()) {
        throw new MobileSwarmCommandError('path_not_allowed', 'Workspace path must be a directory.', false)
      }
    } catch (error) {
      if (error instanceof MobileSwarmCommandError) throw error
      throw new MobileSwarmCommandError('path_not_allowed', 'Workspace path is not accessible.', false)
    }

    return workspacePath
  }

  private async invokeTool(
    command: MobileControlCommand,
    args: string[],
    cwd: string,
    state?: ValidSwarmStatePath,
    artifactId?: string,
    workspacePath?: string
  ): Promise<MobileSwarmCommandResult> {
    const toolResult = await this.execute({ args, cwd })
    const parsed = parseToolJson(toolResult.stdout)

    if (toolResult.exitCode !== 0 || !parsed.ok) {
      const message = parsed.message ?? parsed.error ?? (toolResult.stderr.trim() || 'The swarm tool command failed.')
      return this.reject(command, 'python_tool_failed', message, true, state, artifactId, workspacePath, args, toolResult.exitCode)
    }

    const audit = this.recordAudit({
      command,
      status: 'accepted',
      message: 'Mobile swarm command executed through the canonical swarm tool.',
      state,
      artifactId,
      workspacePath,
      toolArgs: redactToolArgs(args),
      exitCode: toolResult.exitCode,
    })

    return {
      ok: true,
      commandId: command.commandId,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      executedAt: audit.recordedAt,
      data: parsed.data,
      stdout: toolResult.stdout,
      stderr: toolResult.stderr,
      audit,
    }
  }

  private acceptSessionCommand(
    command: MobileControlCommand,
    data: unknown,
    state: ValidSwarmStatePath,
    message: string
  ): MobileSwarmCommandResult {
    const audit = this.recordAudit({
      command,
      status: 'accepted',
      message,
      state,
    })

    return {
      ok: true,
      commandId: command.commandId,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      executedAt: audit.recordedAt,
      data,
      stdout: '',
      stderr: '',
      audit,
    }
  }

  private validateCommandTtl(command: MobileControlCommand): string | null {
    const issuedAt = Date.parse(command.issuedAt)
    const now = this.now().getTime()
    if (issuedAt > now + 5_000) {
      return 'Command issue time is too far in the future.'
    }
    if (now - issuedAt > this.commandTtlMs) {
      return 'Command has expired.'
    }
    return null
  }

  private isAllowedWorkspace(targetPath: string): boolean {
    return this.allowedWorkspaceRoots.some((workspaceRoot) => isPathInsideOrEqual(workspaceRoot, targetPath))
  }

  private replayCachedResult(
    command: MobileControlCommand,
    key: string,
    requestHash: string
  ): MobileSwarmCommandResult | null {
    const cached = idempotencyResults.get(key)
    if (!cached) return null

    if (cached.requestHash !== requestHash) {
      return this.reject(command, 'duplicate_idempotency_key', 'This idempotency key was already used for a different command body.', false)
    }

    const replayed = cloneCommandResult(cached.result)
    const replayStatus = replayed.ok ? 'accepted' : replayed.audit.status
    const audit = this.recordAudit({
      command,
      status: replayStatus,
      code: replayed.ok ? undefined : replayed.error.code,
      message: 'Mobile swarm command result was replayed for a matching idempotency key.',
    })

    return replayed.ok
      ? {
          ...replayed,
          commandId: command.commandId,
          commandType: command.type,
          idempotencyKey: command.idempotencyKey,
          audit,
        }
      : {
          ...replayed,
          commandId: command.commandId,
          commandType: command.type,
          idempotencyKey: command.idempotencyKey,
          audit,
        }
  }

  private rememberIdempotencyResult(key: string, requestHash: string, result: MobileSwarmCommandResult): void {
    idempotencyResults.set(key, {
      requestHash,
      result: cloneCommandResult(result),
    })
    while (idempotencyResults.size > maxRememberedIdempotencyKeys) {
      const oldest = idempotencyResults.keys().next().value as string | undefined
      if (!oldest) break
      idempotencyResults.delete(oldest)
    }
  }

  private idempotencyKeyFor(command: MobileControlCommand): string {
    return `${this.workspaceRoot}:${command.deviceId}:${command.idempotencyKey}`
  }

  private reject(
    command: MobileControlCommand,
    code: MobileControlError['code'],
    message: string,
    retryable: boolean,
    state?: ValidSwarmStatePath,
    artifactId?: string,
    workspacePath?: string,
    toolArgs?: string[],
    exitCode?: number | null
  ): MobileSwarmCommandResult {
    const audit = this.recordAudit({
      command,
      status: code === 'python_tool_failed' ? 'failed' : 'rejected',
      code,
      message,
      state,
      artifactId,
      workspacePath,
      toolArgs: toolArgs ? redactToolArgs(toolArgs) : undefined,
      exitCode,
    })

    return {
      ok: false,
      commandId: command.commandId,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      error: buildError(code, message, retryable),
      audit,
    }
  }

  private rejectUnknown(error: MobileControlError): MobileSwarmCommandResult {
    const audit = this.recordAudit({
      status: 'rejected',
      code: error.code,
      message: error.message,
    })

    return {
      ok: false,
      commandId: null,
      commandType: 'unknown',
      error,
      audit,
    }
  }

  private recordAudit(input: {
    command?: MobileControlCommand
    status: MobileSwarmCommandAuditStatus
    code?: MobileControlError['code']
    message: string
    state?: ValidSwarmStatePath
    artifactId?: string
    workspacePath?: string
    toolArgs?: string[]
    exitCode?: number | null
  }): MobileSwarmCommandAuditEntry {
    const entry: MobileSwarmCommandAuditEntry = {
      auditId: `msa_${randomUUID()}`,
      commandId: input.command?.commandId ?? 'unknown',
      commandType: input.command?.type ?? 'unknown',
      deviceId: input.command?.deviceId ?? null,
      ...(input.command?.idempotencyKey ? { idempotencyKey: input.command.idempotencyKey } : {}),
      status: input.status,
      ...(input.code ? { code: input.code } : {}),
      message: input.message,
      recordedAt: this.now().toISOString(),
      ...(input.state ? { statePath: input.state.statePath } : {}),
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.toolArgs ? { toolArgs: input.toolArgs } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    }

    this.auditLog.unshift(entry)
    this.auditSink?.(entry)
    return entry
  }
}

export class MobileSwarmCommandError extends Error {
  constructor(
    readonly code: MobileControlError['code'],
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

function createSwarmToolExecutor(swarmToolPath: string): SwarmToolExecutor {
  return (invocation) => new Promise((resolvePromise) => {
    const executable = process.platform === 'win32' ? 'python' : 'python3'
    const child = spawn(executable, [swarmToolPath, ...invocation.args], {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        SWARM_REPO_WRAPPER_PATH: join(invocation.cwd, 'scripts', 'swarm_tool.py'),
        SWARM_REPO_TOOL_PATH: join(invocation.cwd, '.agents', 'skills', 'swarm-kanban', 'scripts', 'swarm_tool.py'),
      },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolvePromise({ exitCode: 1, stdout, stderr: stderr || error.message })
    })
    child.on('close', (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr })
    })
  })
}

function defaultSwarmToolPath(): string {
  return resolve(process.cwd(), 'scripts', 'swarm_tool.py')
}

function validateSwarmStatePath(input: string): ValidSwarmStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new MobileSwarmCommandError('path_not_allowed', 'A swarm state path is required.', false)
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Swarm state path must be absolute.', false)
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const swarmDirectory = dirname(teamDirectory)
  const workspaceRoot = dirname(swarmDirectory)

  if (basename(statePath) !== 'state.yaml' || basename(swarmDirectory) !== 'swarm' || workspaceRoot === swarmDirectory) {
    throw new MobileSwarmCommandError('path_not_allowed', 'Swarm state path must point to swarm/<team>/state.yaml.', false)
  }

  return { statePath, teamDirectory, workspaceRoot }
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(targetPath))
  return (
    relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..'))
  )
}

function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))]
}

function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== '.' && value !== '..'
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return slug.slice(0, 80) || 'command'
}

function mobileActorId(deviceId: string): string {
  return `mobile:${deviceId.replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, 120)}`
}

function parseToolJson(stdout: string): { ok: boolean; data?: unknown; message?: string; error?: string } {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>
    return {
      ok: data.ok === true,
      data,
      message: typeof data.message === 'string' ? data.message : undefined,
      error: typeof data.error === 'string' ? data.error : undefined,
    }
  } catch {
    return { ok: false, error: 'Swarm tool did not return valid JSON.' }
  }
}

function validateMobileControlCommand(input: unknown): ValidationResult<MobileControlCommand> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: buildError('invalid_payload', 'command must be an object', false) }
  }

  const command = input as Record<string, unknown>
  if (command.protocolVersion !== mobileControlProtocolVersion) {
    return {
      ok: false,
      error: buildError('unsupported_protocol_version', `mobile-control protocol version must be ${mobileControlProtocolVersion}`, false),
    }
  }

  const baseError =
    requireString(command, 'commandId') ??
    requireString(command, 'issuedAt') ??
    requireIsoDate(command, 'issuedAt') ??
    requireString(command, 'deviceId') ??
    optionalString(command, 'idempotencyKey') ??
    optionalString(command, 'expectedSnapshotVersion')
  if (baseError) {
    return { ok: false, error: buildError('invalid_payload', baseError, false) }
  }

  if (!commandTypes.has(command.type as MobileControlCommandType)) {
    return { ok: false, error: buildError('invalid_payload', 'command.type must be a supported mobile-control command', false) }
  }

  if (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) {
    return { ok: false, error: buildError('invalid_payload', 'command.payload must be an object', false) }
  }

  const payload = command.payload as Record<string, unknown>
  const payloadError = validateCommandPayload(command.type as MobileControlCommandType, payload)
  if (payloadError) {
    return { ok: false, error: buildError('invalid_payload', payloadError, false) }
  }

  return { ok: true, value: input as MobileControlCommand }
}

function validateCommandPayload(type: MobileControlCommandType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case 'swarm.create':
      return requireString(payload, 'workspacePath') ?? requireString(payload, 'productPrompt') ?? optionalString(payload, 'requestedRole')
    case 'artifact.approve':
      return requireString(payload, 'swarmId') ?? requireString(payload, 'artifactId') ?? optionalString(payload, 'feedback')
    case 'artifact.requestChanges':
      return requireString(payload, 'swarmId') ?? requireString(payload, 'artifactId') ?? requireString(payload, 'feedback')
    case 'snapshot.request':
      return optionalString(payload, 'swarmId')
    case 'artifact.read':
      return requireString(payload, 'swarmId') ?? requireString(payload, 'artifactId') ?? requireString(payload, 'previewMode')
    case 'task.start':
      return requireString(payload, 'swarmId') ?? requireString(payload, 'taskId') ?? requireString(payload, 'role') ?? optionalWorktreeIsolation(payload, 'worktreeIsolation')
    case 'agent.followUp':
      return requireString(payload, 'swarmId') ?? requireString(payload, 'agentId') ?? requireString(payload, 'text')
    case 'device.revoke':
      return requireString(payload, 'deviceId') ?? optionalString(payload, 'reason')
  }
}

function normalizeSwarmTasks(value: unknown): SwarmTaskRecord[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((task): SwarmTaskRecord[] => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return []
    const record = task as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id.trim()) return []
    if (typeof record.role !== 'string' || !record.role.trim()) return []

    return [{
      id: record.id,
      role: record.role,
      status: normalizeTaskStatus(record.status),
      ownerAgentId: typeof record.ownerAgentId === 'string' && record.ownerAgentId.trim()
        ? record.ownerAgentId
        : null,
      dependsOn: Array.isArray(record.dependsOn)
        ? record.dependsOn.filter((dependency): dependency is string => typeof dependency === 'string')
        : [],
    }]
  })
}

function normalizeTaskStatus(value: unknown): SwarmTaskRecord['status'] {
  if (value === 'in_progress' || value === 'needs_input' || value === 'done') return value
  return 'todo'
}

function normalizeWorktreeIsolation(value: unknown): MobileTaskStartWorktreeIsolation {
  return value === 'required' || value === 'disabled' ? value : 'preferred'
}

function normalizeFollowUpText(value: string): string {
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new MobileSwarmCommandError('invalid_payload', 'Follow-up text must be a single message without terminal control characters.', false)
  }

  const text = value.trim()
  if (!text) {
    throw new MobileSwarmCommandError('invalid_payload', 'Follow-up text is required.', false)
  }
  if (text.length > maxFollowUpCharacters) {
    throw new MobileSwarmCommandError('invalid_payload', `Follow-up text must be ${maxFollowUpCharacters} characters or less.`, false)
  }
  return text
}

function requestHashFor(command: MobileControlCommand): string {
  const hashInput = stableJsonStringify({
    protocolVersion: command.protocolVersion,
    type: command.type,
    expectedSnapshotVersion: command.expectedSnapshotVersion ?? null,
    payload: command.payload,
  })
  return createHash('sha256').update(hashInput).digest('hex')
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(',')}}`
}

function cloneCommandResult(result: MobileSwarmCommandResult): MobileSwarmCommandResult {
  return JSON.parse(JSON.stringify(result)) as MobileSwarmCommandResult
}

function requireString(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === 'string' && record[field].length > 0 ? null : `${field} must be a non-empty string`
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || (typeof record[field] === 'string' && record[field].length > 0)
    ? null
    : `${field} must be a non-empty string when provided`
}

function optionalWorktreeIsolation(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  return value === undefined || value === 'preferred' || value === 'required' || value === 'disabled'
    ? null
    : `${field} must be preferred, required, or disabled when provided`
}

function requireIsoDate(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return `${field} must be an ISO 8601 timestamp`
  }
  return null
}

function redactToolArgs(args: string[]): string[] {
  const redacted = [...args]
  for (let index = 0; index < redacted.length - 1; index += 1) {
    if (redacted[index] === '--feedback' || redacted[index] === '--goal' || redacted[index] === '--handover-text') {
      redacted[index + 1] = '[redacted]'
    }
  }
  return redacted
}

function buildError(code: MobileControlError['code'], message: string, retryable: boolean): MobileControlError {
  return {
    protocolVersion: mobileControlProtocolVersion,
    code,
    message,
    retryable,
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof MobileSwarmCommandError) return error.message
  return error instanceof Error ? error.message : String(error)
}
