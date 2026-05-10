import { resolve } from 'path'
import {
  idempotencyKeyForCommand,
  rememberedCommandResult,
  rememberCommandResult,
  requestHashFor,
} from './command-cache'
import { validateMobileControlCommand } from './command-validation'
import {
  mobileActorId,
  safeSlug,
  uniqueResolved,
} from './path-utils'
import {
  createSprintEngineToolExecutor,
  defaultSprintEngineToolPath,
  parseToolJson,
  type SprintEngineToolExecutor,
} from './tool-runner'
import {
  getMobileSprintEngineCommandErrorMessage,
  MobileSprintEngineCommandError,
} from './command-error'
import {
  validateSprintEngineStatePath,
  type ValidSprintEngineStatePath,
} from './state-path'
import { normalizeFollowUpText } from './follow-up-text'
import {
  assertKnownActiveSprintEngineAgent,
  findReadySprintEngineTask,
  findSprintEngineArtifact,
} from './state-reader'
import { MobileSprintEngineCommandResultRecorder } from './command-results'
import {
  assertExpectedSnapshotVersion,
  resolveStateForSprintEngine,
  validateMobileWorkspacePath,
} from './workspace'

export { MobileSprintEngineCommandError } from './command-error'

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
  | 'sprintengine_not_found'
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

type SprintEngineCreateCommand = MobileControlCommandBase<
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
    sprintEngineId: string
    taskId: string
    role: string
  }
>

type AgentFollowUpCommand = MobileControlCommandBase<
  'agent.followUp',
  {
    sprintEngineId: string
    agentId: string
    text: string
  }
>

type ArtifactApproveCommand = MobileControlCommandBase<
  'artifact.approve',
  {
    sprintEngineId: string
    artifactId: string
    feedback?: string
  }
>

type ArtifactRequestChangesCommand = MobileControlCommandBase<
  'artifact.requestChanges',
  {
    sprintEngineId: string
    artifactId: string
    feedback: string
  }
>

type UnsupportedMobileControlCommand = MobileControlCommandBase<
  Exclude<MobileControlCommandType, 'sprintengine.create' | 'task.start' | 'agent.followUp' | 'artifact.approve' | 'artifact.requestChanges'>,
  Record<string, unknown>
>

export type MobileControlCommand =
  | SprintEngineCreateCommand
  | TaskStartCommand
  | AgentFollowUpCommand
  | ArtifactApproveCommand
  | ArtifactRequestChangesCommand
  | UnsupportedMobileControlCommand

export type MobileSprintEngineTaskStartRequest = {
  sprintEngineId: string
  statePath: string
  teamDirectory: string
  workspaceRoot: string
  taskId: string
  role: string
  deviceId: string
  commandId: string
}

export type MobileSprintEngineTaskStartResult = {
  sessionId: string
  agentId: string
  executionMode: 'current_workspace' | 'worktree'
}

export type MobileSprintEngineFollowUpRequest = {
  sprintEngineId: string
  statePath: string
  teamDirectory: string
  workspaceRoot: string
  agentId: string
  text: string
  deviceId: string
  commandId: string
}

export type MobileSprintEngineFollowUpResult = {
  sessionId: string
  agentId: string
  acceptedAt: string
}

export type MobileSprintEngineSessionOrchestrator = {
  startTask(request: MobileSprintEngineTaskStartRequest): Promise<MobileSprintEngineTaskStartResult>
  sendFollowUp(request: MobileSprintEngineFollowUpRequest): Promise<MobileSprintEngineFollowUpResult>
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
export type SprintEngineArtifactReviewAction = 'approve' | 'request-changes'

export function buildSprintEngineArtifactReviewArgs(input: {
  statePath: string
  action: SprintEngineArtifactReviewAction
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

type MobileSprintEngineCommandServiceOptions = {
  workspaceRoot?: string
  allowedWorkspaceRoots?: string[]
  statePaths?: string[]
  sprintEngineToolPath?: string
  commandTtlMs?: number
  now?: () => Date
  execute?: SprintEngineToolExecutor
  sessionOrchestrator?: MobileSprintEngineSessionOrchestrator
  auditSink?: (entry: MobileSprintEngineCommandAuditEntry) => void
}

export type MobileSprintEngineCommandAuditEntry = {
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

export type MobileSprintEngineCommandResult =
  | {
      ok: true
      commandId: string
      commandType: MobileControlCommandType
      idempotencyKey?: string
      executedAt: string
      data: unknown
      stdout: string
      stderr: string
      audit: MobileSprintEngineCommandAuditEntry
    }
  | {
      ok: false
      commandId: string | null
      commandType: MobileControlCommandType | 'unknown'
      idempotencyKey?: string
      error: MobileControlError
      audit: MobileSprintEngineCommandAuditEntry
    }

export class MobileSprintEngineCommandService {
  private readonly workspaceRoot: string
  private readonly allowedWorkspaceRoots: string[]
  private readonly statePaths: string[]
  private readonly commandTtlMs: number
  private readonly now: () => Date
  private readonly execute: SprintEngineToolExecutor
  private readonly sessionOrchestrator?: MobileSprintEngineSessionOrchestrator
  private readonly resultRecorder: MobileSprintEngineCommandResultRecorder

  constructor(options: MobileSprintEngineCommandServiceOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
    this.allowedWorkspaceRoots = uniqueResolved([
      this.workspaceRoot,
      ...(options.allowedWorkspaceRoots ?? []),
    ])
    this.statePaths = (options.statePaths ?? []).map((statePath) => validateSprintEngineStatePath(statePath).statePath)
    this.commandTtlMs = Math.max(1, options.commandTtlMs ?? defaultCommandTtlMs)
    this.now = options.now ?? (() => new Date())
    this.execute = options.execute ?? createSprintEngineToolExecutor(options.sprintEngineToolPath ?? defaultSprintEngineToolPath())
    this.sessionOrchestrator = options.sessionOrchestrator
    this.resultRecorder = new MobileSprintEngineCommandResultRecorder(this.now, options.auditSink)
  }

  getAuditLog(): MobileSprintEngineCommandAuditEntry[] {
    return this.resultRecorder.getAuditLog()
  }

  async dispatch(input: unknown): Promise<MobileSprintEngineCommandResult> {
    const validated = validateMobileControlCommand(input)
    if (!validated.ok) {
      return this.resultRecorder.rejectUnknown(validated.error)
    }

    const command = validated.value
    if (!allowedCommandTypes.has(command.type)) {
      return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the Sprint Engine command service.`, false)
    }

    if (!command.idempotencyKey) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'idempotencyKey is required for Sprint Engine mutation commands.', false)
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
      if (error instanceof MobileSprintEngineCommandError) {
        const result = this.resultRecorder.reject(command, error.code, error.message, error.retryable)
        rememberCommandResult(idempotencyKey, requestHash, result)
        return result
      }
      const result = this.resultRecorder.reject(command, 'internal_error', getMobileSprintEngineCommandErrorMessage(error), false)
      rememberCommandResult(idempotencyKey, requestHash, result)
      return result
    }
  }

  private async executeCommand(command: MobileControlCommand): Promise<MobileSprintEngineCommandResult> {
    switch (command.type) {
      case 'artifact.approve':
        return this.executeArtifactReviewCommand(command, 'approve')
      case 'artifact.requestChanges':
        return this.executeArtifactReviewCommand(command, 'request-changes')
      case 'sprintengine.create':
        return this.executeSprintEngineCreateCommand(command)
      case 'task.start':
        return this.executeTaskStartCommand(command)
      case 'agent.followUp':
        return this.executeAgentFollowUpCommand(command)
      case 'snapshot.request':
      case 'artifact.read':
      case 'device.revoke':
        return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the Sprint Engine command service.`, false)
    }
  }

  private async executeTaskStartCommand(
    command: Extract<MobileControlCommand, { type: 'task.start' }>
  ): Promise<MobileSprintEngineCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.resultRecorder.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile task starts.', false)
    }

    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId)
    await assertExpectedSnapshotVersion({
      expectedSnapshotVersion: command.expectedSnapshotVersion,
      statePath: state.statePath,
    })
    const task = await findReadySprintEngineTask(state, command.payload.taskId, command.payload.role)

    const data = await this.sessionOrchestrator.startTask({
      sprintEngineId: command.payload.sprintEngineId,
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
  ): Promise<MobileSprintEngineCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.resultRecorder.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile follow-up messages.', false)
    }

    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId)
    await assertExpectedSnapshotVersion({
      expectedSnapshotVersion: command.expectedSnapshotVersion,
      statePath: state.statePath,
    })
    const text = normalizeFollowUpText(command.payload.text)
    await assertKnownActiveSprintEngineAgent(state, command.payload.agentId)

    const data = await this.sessionOrchestrator.sendFollowUp({
      sprintEngineId: command.payload.sprintEngineId,
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
  ): Promise<MobileSprintEngineCommandResult> {
    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId)
    await assertExpectedSnapshotVersion({
      expectedSnapshotVersion: command.expectedSnapshotVersion,
      statePath: state.statePath,
    })
    const artifact = await findSprintEngineArtifact(state, command.payload.artifactId)

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

    const args = buildSprintEngineArtifactReviewArgs({
      statePath: state.statePath,
      action,
      artifactId: artifact.id,
      actorId,
      feedback,
    })

    return this.invokeTool(command, args, state.workspaceRoot, state, artifact.id)
  }

  private async executeSprintEngineCreateCommand(
    command: Extract<MobileControlCommand, { type: 'sprintengine.create' }>
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: this.allowedWorkspaceRoots,
    })
    const productPrompt = command.payload.productPrompt.trim()
    if (!productPrompt) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'Sprint Engine creation requires a product prompt.', false, undefined, undefined, workspacePath)
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

  private async resolveStateForSprintEngine(sprintEngineId: string): Promise<ValidSprintEngineStatePath> {
    return resolveStateForSprintEngine({
      sprintEngineId,
      statePaths: this.statePaths,
      workspaceRoot: this.workspaceRoot,
      allowedWorkspaceRoots: this.allowedWorkspaceRoots,
    })
  }

  private async invokeTool(
    command: MobileControlCommand,
    args: string[],
    cwd: string,
    state?: ValidSprintEngineStatePath,
    artifactId?: string,
    workspacePath?: string
  ): Promise<MobileSprintEngineCommandResult> {
    const toolResult = await this.execute({ args, cwd })
    const parsed = parseToolJson(toolResult.stdout)

    if (toolResult.exitCode !== 0 || !parsed.ok) {
      const message = parsed.message ?? parsed.error ?? (toolResult.stderr.trim() || 'The Sprint Engine tool command failed.')
      return this.resultRecorder.reject(command, 'python_tool_failed', message, true, state, artifactId, workspacePath, args, toolResult.exitCode)
    }

    const audit = this.resultRecorder.recordAudit({
      command,
      status: 'accepted',
      message: 'Mobile Sprint Engine command executed through the canonical Sprint Engine tool.',
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

  private replayCachedResult(
    command: MobileControlCommand,
    key: string,
    requestHash: string
  ): MobileSprintEngineCommandResult | null {
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
      message: 'Mobile Sprint Engine command result was replayed for a matching idempotency key.',
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
