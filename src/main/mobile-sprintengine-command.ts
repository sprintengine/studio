import { access, stat } from 'fs/promises'
import { constants } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { readSwarmSnapshot } from './mobile-sprintengine-snapshot'
import {
  idempotencyKeyForCommand,
  rememberedCommandResult,
  rememberCommandResult,
  requestHashFor,
} from './mobile-sprintengine-command-cache'
import { validateMobileControlCommand } from './mobile-sprintengine-command-validation'
import {
  isPathInsideOrEqual,
  isSafePathSegment,
  mobileActorId,
  safeSlug,
  uniqueResolved,
} from './mobile-sprintengine-path-utils'
import {
  createSwarmToolExecutor,
  defaultSwarmToolPath,
  parseToolJson,
  type SwarmToolExecutor,
} from './mobile-sprintengine-tool-runner'
import {
  getMobileSwarmCommandErrorMessage,
  MobileSwarmCommandError,
} from './mobile-sprintengine-command-error'
import {
  validateSwarmStatePath,
  type ValidSwarmStatePath,
} from './mobile-sprintengine-state-path'
import { normalizeFollowUpText } from './mobile-sprintengine-follow-up-text'
import {
  assertKnownActiveSwarmAgent,
  findReadySwarmTask,
  findSwarmArtifact,
} from './mobile-sprintengine-state-reader'
import { MobileSwarmCommandResultRecorder } from './mobile-sprintengine-command-results'

export { MobileSwarmCommandError } from './mobile-sprintengine-command-error'

export const mobileControlProtocolVersion = 1 as const

export type MobileControlCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'sprintengine.create'
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
  'sprintengine.create',
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
  Exclude<MobileControlCommandType, 'sprintengine.create' | 'task.start' | 'agent.followUp' | 'artifact.approve' | 'artifact.requestChanges'>,
  Record<string, unknown>
>

export type MobileControlCommand =
  | SwarmCreateCommand
  | TaskStartCommand
  | AgentFollowUpCommand
  | ArtifactApproveCommand
  | ArtifactRequestChangesCommand
  | UnsupportedMobileControlCommand

export type MobileSwarmTaskStartRequest = {
  swarmId: string
  statePath: string
  teamDirectory: string
  workspaceRoot: string
  taskId: string
  role: string
  deviceId: string
  commandId: string
}

export type MobileSwarmTaskStartResult = {
  sessionId: string
  agentId: string
  executionMode: 'current_workspace' | 'worktree'
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

const defaultCommandTtlMs = 30_000
const maxProductPromptCharacters = 20_000
const maxFeedbackCharacters = 8_000
const allowedCommandTypes = new Set<MobileControlCommandType>([
  'sprintengine.create',
  'task.start',
  'agent.followUp',
  'artifact.approve',
  'artifact.requestChanges',
])
export type SwarmArtifactReviewAction = 'approve' | 'request-changes'

export function buildSwarmArtifactReviewArgs(input: {
  statePath: string
  action: SwarmArtifactReviewAction
  artifactId: string
  actorId: string
  feedback?: string
}): string[] {
  return [
    '--state',
    input.statePath,
    'artifact',
    input.action,
    '--artifact-id',
    input.artifactId,
    '--id',
    input.actorId,
    ...(input.action === 'request-changes' && input.feedback ? ['--feedback', input.feedback] : []),
  ]
}

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

export type MobileSwarmCommandAuditEntry = {
  auditId: string
  commandId: string
  commandType: MobileControlCommandType | 'unknown'
  deviceId: string | null
  idempotencyKey?: string
  status: 'accepted' | 'rejected' | 'failed'
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

export class MobileSwarmCommandService {
  private readonly workspaceRoot: string
  private readonly allowedWorkspaceRoots: string[]
  private readonly statePaths: string[]
  private readonly commandTtlMs: number
  private readonly now: () => Date
  private readonly execute: SwarmToolExecutor
  private readonly sessionOrchestrator?: MobileSwarmSessionOrchestrator
  private readonly resultRecorder: MobileSwarmCommandResultRecorder

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
    this.resultRecorder = new MobileSwarmCommandResultRecorder(this.now, options.auditSink)
  }

  getAuditLog(): MobileSwarmCommandAuditEntry[] {
    return this.resultRecorder.getAuditLog()
  }

  async dispatch(input: unknown): Promise<MobileSwarmCommandResult> {
    const validated = validateMobileControlCommand(input)
    if (!validated.ok) {
      return this.resultRecorder.rejectUnknown(validated.error)
    }

    const command = validated.value
    if (!allowedCommandTypes.has(command.type)) {
      return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the sprintengine command service.`, false)
    }

    if (!command.idempotencyKey) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'idempotencyKey is required for sprintengine mutation commands.', false)
    }

    const idempotencyKey = idempotencyKeyForCommand(this.workspaceRoot, command)
    const requestHash = requestHashFor(command)
    const cachedResult = this.replayCachedResult(command, idempotencyKey, requestHash)
    if (cachedResult) {
      return cachedResult
    }

    const ttlError = this.validateCommandTtl(command)
    if (ttlError) {
      return this.resultRecorder.reject(command, 'command_expired', ttlError, false)
    }

    try {
      const result = await this.executeCommand(command)
      rememberCommandResult(idempotencyKey, requestHash, result)
      return result
    } catch (error) {
      if (error instanceof MobileSwarmCommandError) {
        const result = this.resultRecorder.reject(command, error.code, error.message, error.retryable)
        rememberCommandResult(idempotencyKey, requestHash, result)
        return result
      }
      const result = this.resultRecorder.reject(command, 'internal_error', getMobileSwarmCommandErrorMessage(error), false)
      rememberCommandResult(idempotencyKey, requestHash, result)
      return result
    }
  }

  private async executeCommand(command: MobileControlCommand): Promise<MobileSwarmCommandResult> {
    switch (command.type) {
      case 'artifact.approve':
        return this.executeArtifactReviewCommand(command, 'approve')
      case 'artifact.requestChanges':
        return this.executeArtifactReviewCommand(command, 'request-changes')
      case 'sprintengine.create':
        return this.executeSwarmCreateCommand(command)
      case 'task.start':
        return this.executeTaskStartCommand(command)
      case 'agent.followUp':
        return this.executeAgentFollowUpCommand(command)
      case 'snapshot.request':
      case 'artifact.read':
      case 'device.revoke':
        return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the sprintengine command service.`, false)
    }
  }

  private async executeTaskStartCommand(
    command: Extract<MobileControlCommand, { type: 'task.start' }>
  ): Promise<MobileSwarmCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.resultRecorder.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile task starts.', false)
    }

    const state = await this.resolveStateForSwarm(command.payload.swarmId)
    await this.assertExpectedSnapshotVersion(command, state.statePath)
    const task = await findReadySwarmTask(state, command.payload.taskId, command.payload.role)

    const data = await this.sessionOrchestrator.startTask({
      swarmId: command.payload.swarmId,
      statePath: state.statePath,
      teamDirectory: state.teamDirectory,
      workspaceRoot: state.workspaceRoot,
      taskId: task.id,
      role: task.role,
      deviceId: command.deviceId,
      commandId: command.commandId,
    })

    return this.resultRecorder.acceptSessionCommand(
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
      return this.resultRecorder.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile follow-up messages.', false)
    }

    const state = await this.resolveStateForSwarm(command.payload.swarmId)
    await this.assertExpectedSnapshotVersion(command, state.statePath)
    const text = normalizeFollowUpText(command.payload.text)
    await assertKnownActiveSwarmAgent(state, command.payload.agentId)

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

    return this.resultRecorder.acceptSessionCommand(
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
    const artifact = await findSwarmArtifact(state, command.payload.artifactId)

    const actorId = mobileActorId(command.deviceId)
    let feedback: string | undefined

    if (action === 'request-changes') {
      feedback = typeof command.payload.feedback === 'string' ? command.payload.feedback.trim() : ''
      if (!feedback) {
        return this.resultRecorder.reject(command, 'invalid_payload', 'Artifact change requests require feedback.', false, state, artifact.id)
      }
      if (feedback.length > maxFeedbackCharacters) {
        return this.resultRecorder.reject(command, 'invalid_payload', `Artifact feedback must be ${maxFeedbackCharacters} characters or less.`, false, state, artifact.id)
      }
    }

    const args = buildSwarmArtifactReviewArgs({
      statePath: state.statePath,
      action,
      artifactId: artifact.id,
      actorId,
      feedback,
    })

    return this.invokeTool(command, args, state.workspaceRoot, state, artifact.id)
  }

  private async executeSwarmCreateCommand(
    command: Extract<MobileControlCommand, { type: 'sprintengine.create' }>
  ): Promise<MobileSwarmCommandResult> {
    const workspacePath = await this.validateWorkspacePath(command.payload.workspacePath)
    const productPrompt = command.payload.productPrompt.trim()
    if (!productPrompt) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'SprintEngine creation requires a product prompt.', false, undefined, undefined, workspacePath)
    }
    if (productPrompt.length > maxProductPromptCharacters) {
      return this.resultRecorder.reject(command, 'invalid_payload', `Product prompt must be ${maxProductPromptCharacters} characters or less.`, false, undefined, undefined, workspacePath)
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
      throw new MobileSwarmCommandError('path_not_allowed', 'SprintEngine id must be a single safe path segment.', false)
    }

    const statePath = this.statePaths.length > 0
      ? this.statePaths.find((candidate) => basename(dirname(candidate)) === swarmId)
      : join(this.workspaceRoot, '.multi-code', 'sprintengine', swarmId, 'state.yaml')

    if (!statePath) {
      throw new MobileSwarmCommandError('swarm_not_found', 'Requested sprintengine is not available to mobile control.', false)
    }

    const state = validateSwarmStatePath(statePath)
    if (!this.isAllowedWorkspace(state.workspaceRoot)) {
      throw new MobileSwarmCommandError('path_not_allowed', 'Sprint Engine state path is outside the allowed workspace roots.', false)
    }

    try {
      const stateStats = await stat(state.statePath)
      if (!stateStats.isFile()) {
        throw new MobileSwarmCommandError('swarm_not_found', 'Sprint Engine state path is not a file.', false)
      }
    } catch (error) {
      if (error instanceof MobileSwarmCommandError) throw error
      throw new MobileSwarmCommandError('swarm_not_found', 'Requested Sprint Engine state was not found.', false)
    }

    return state
  }

  private async assertExpectedSnapshotVersion(command: MobileControlCommand, statePath: string): Promise<void> {
    if (!command.expectedSnapshotVersion) return
    const snapshot = await readSwarmSnapshot(statePath)
    if (snapshot.snapshotVersion !== command.expectedSnapshotVersion) {
      throw new MobileSwarmCommandError('stale_snapshot', 'Command was based on a stale sprintengine snapshot.', false)
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
      const message = parsed.message ?? parsed.error ?? (toolResult.stderr.trim() || 'The Sprint Engine tool command failed.')
      return this.resultRecorder.reject(command, 'python_tool_failed', message, true, state, artifactId, workspacePath, args, toolResult.exitCode)
    }

    const audit = this.resultRecorder.recordAudit({
      command,
      status: 'accepted',
      message: 'Mobile sprintengine command executed through the canonical Sprint Engine tool.',
      state,
      artifactId,
      workspacePath,
      toolArgs: args,
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
    const remembered = rememberedCommandResult(key, requestHash)
    if (remembered.status === 'miss') return null

    if (remembered.status === 'conflict') {
      return this.resultRecorder.reject(command, 'duplicate_idempotency_key', 'This idempotency key was already used for a different command body.', false)
    }

    const replayed = remembered.result
    const replayStatus = replayed.ok ? 'accepted' : replayed.audit.status
    const audit = this.resultRecorder.recordAudit({
      command,
      status: replayStatus,
      code: replayed.ok ? undefined : replayed.error.code,
      message: 'Mobile sprintengine command result was replayed for a matching idempotency key.',
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

}
