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
  redactToolArgs,
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
import { assertBacklogRelativePath, resolveBacklogStartPrompt } from './backlog'
import {
  createBacklogItem,
  updateBacklogModuleMetadata,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from '../../backlog-service'
import type {
  BacklogCriticalityPayload,
  BacklogDifficultyPayload,
  BacklogItemStatusPayload,
  BacklogMutationResult,
  BacklogObjectStorePayload,
  BacklogTypePayload,
} from '../../../shared/electron-api'

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
  | 'backlog.update'
  | 'backlog.startSprintEngine'
  | 'backlog.create'

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
  | 'snapshot_too_large'
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
    worktreeIsolation: 'required' | 'preferred' | 'disabled'
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

type BacklogUpdateCommand = MobileControlCommandBase<
  'backlog.update',
  {
    workspacePath: string
    relativePath: string
    status?: string
    type?: string
    difficulty?: string
    criticality?: string
  }
>

type BacklogStartSprintEngineCommand = MobileControlCommandBase<
  'backlog.startSprintEngine',
  {
    workspacePath: string
    relativePath: string
  }
>

type BacklogCreateCommand = MobileControlCommandBase<
  'backlog.create',
  {
    workspacePath: string
    title: string
    description?: string
    type?: string
    difficulty?: string
    criticality?: string
  }
>

type UnsupportedMobileControlCommand = MobileControlCommandBase<
  Exclude<
    MobileControlCommandType,
    'sprintengine.create' | 'task.start' | 'agent.followUp' | 'artifact.approve' | 'artifact.requestChanges' | 'backlog.update' | 'backlog.startSprintEngine' | 'backlog.create'
  >,
  Record<string, unknown>
>

export type MobileControlCommand =
  | SprintEngineCreateCommand
  | TaskStartCommand
  | AgentFollowUpCommand
  | ArtifactApproveCommand
  | ArtifactRequestChangesCommand
  | BacklogUpdateCommand
  | BacklogStartSprintEngineCommand
  | BacklogCreateCommand
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
  'backlog.update',
  'backlog.startSprintEngine',
  'backlog.create',
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

export type MobileSprintEngineCommandDispatchOptions = {
  allowedWorkspaceRoots?: string[]
  statePaths?: string[]
}

type MobileSprintEngineCommandScope = {
  allowedWorkspaceRoots: string[]
  statePaths: string[]
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
  private readonly configuredAllowedWorkspaceRoots: string[]
  private readonly configuredStatePaths: string[]
  private readonly commandTtlMs: number
  private readonly now: () => Date
  private readonly execute: SprintEngineToolExecutor
  private readonly sessionOrchestrator?: MobileSprintEngineSessionOrchestrator
  private readonly resultRecorder: MobileSprintEngineCommandResultRecorder

  constructor(options: MobileSprintEngineCommandServiceOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
    this.configuredAllowedWorkspaceRoots = uniqueResolved([
      this.workspaceRoot,
      ...(options.allowedWorkspaceRoots ?? []),
    ])
    this.configuredStatePaths = (options.statePaths ?? []).map((statePath) => validateSprintEngineStatePath(statePath).statePath)
    this.commandTtlMs = Math.max(1, options.commandTtlMs ?? defaultCommandTtlMs)
    this.now = options.now ?? (() => new Date())
    this.execute = options.execute ?? createSprintEngineToolExecutor(options.sprintEngineToolPath ?? defaultSprintEngineToolPath())
    this.sessionOrchestrator = options.sessionOrchestrator
    this.resultRecorder = new MobileSprintEngineCommandResultRecorder(this.now, options.auditSink)
  }

  getAuditLog(): MobileSprintEngineCommandAuditEntry[] {
    return this.resultRecorder.getAuditLog()
  }

  async dispatch(input: unknown, options: MobileSprintEngineCommandDispatchOptions = {}): Promise<MobileSprintEngineCommandResult> {
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
      const scope = this.commandScope(options)
      const result = await this.executeCommand(command, scope)
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

  private async executeCommand(
    command: MobileControlCommand,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    switch (command.type) {
      case 'artifact.approve':
        return this.executeArtifactReviewCommand(command, 'approve', scope)
      case 'artifact.requestChanges':
        return this.executeArtifactReviewCommand(command, 'request-changes', scope)
      case 'sprintengine.create':
        return this.executeSprintEngineCreateCommand(command, scope)
      case 'backlog.update':
        return this.executeBacklogUpdateCommand(command, scope)
      case 'backlog.startSprintEngine':
        return this.executeBacklogStartSprintEngineCommand(command, scope)
      case 'backlog.create':
        return this.executeBacklogCreateCommand(command, scope)
      case 'task.start':
        return this.executeTaskStartCommand(command, scope)
      case 'agent.followUp':
        return this.executeAgentFollowUpCommand(command, scope)
      case 'snapshot.request':
      case 'artifact.read':
      case 'device.revoke':
        return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the Sprint Engine command service.`, false)
    }
  }

  private async executeTaskStartCommand(
    command: Extract<MobileControlCommand, { type: 'task.start' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.resultRecorder.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile task starts.', false)
    }

    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId, scope)
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
    command: Extract<MobileControlCommand, { type: 'agent.followUp' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.resultRecorder.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile follow-up messages.', false)
    }

    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId, scope)
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
    action: 'approve' | 'request-changes',
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId, scope)
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
    command: Extract<MobileControlCommand, { type: 'sprintengine.create' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
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

  private async executeBacklogUpdateCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.update' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
    })
    const relativePath = assertBacklogRelativePath(command.payload.relativePath)
    const { status, type, difficulty, criticality } = command.payload
    if (status === undefined && type === undefined && difficulty === undefined && criticality === undefined) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'Backlog updates require at least one of status, type, difficulty, or criticality.', false, undefined, undefined, workspacePath)
    }

    // The store mutations are sequential on purpose: each one is a full
    // read-modify-write of items.json, so running them concurrently would
    // race on the file.
    const mutations: Array<() => Promise<BacklogMutationResult>> = []
    if (status !== undefined) {
      mutations.push(() => updateBacklogStatus({ workspaceRoot: workspacePath, relativePath, status: status as BacklogItemStatusPayload }))
    }
    if (type !== undefined) {
      mutations.push(() => updateBacklogType({ workspaceRoot: workspacePath, relativePath, type: type as BacklogTypePayload }))
    }
    if (difficulty !== undefined || criticality !== undefined) {
      mutations.push(() => updateBacklogTriage({
        workspaceRoot: workspacePath,
        relativePath,
        ...(difficulty !== undefined ? { difficulty: difficulty as BacklogDifficultyPayload } : {}),
        ...(criticality !== undefined ? { criticality: criticality as BacklogCriticalityPayload } : {}),
      }))
    }

    let store: BacklogObjectStorePayload | null = null
    for (const mutation of mutations) {
      const result = await mutation()
      if (!result.ok) {
        return this.resultRecorder.reject(command, 'invalid_payload', result.message, false, undefined, undefined, workspacePath)
      }
      store = result.store
    }

    const item = store?.items.find((record) => record.source.relativePath.toLowerCase() === relativePath.toLowerCase()) ?? null
    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      { item },
      workspacePath,
      'Mobile backlog update was applied to the workspace backlog store.'
    )
  }

  private async executeBacklogStartSprintEngineCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.startSprintEngine' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
    })
    const relativePath = assertBacklogRelativePath(command.payload.relativePath)
    const { title, prompt } = await resolveBacklogStartPrompt(workspacePath, relativePath)

    const teamName = `backlog-${safeSlug(command.commandId)}`
    const args = [
      'handover',
      '--name',
      teamName,
      '--goal',
      title,
      '--handover-text',
      prompt,
      '--actor',
      mobileActorId(command.deviceId),
    ]

    const result = await this.invokeTool(command, args, workspacePath, undefined, undefined, workspacePath)
    if (!result.ok) {
      return result
    }

    // Best-effort lifecycle bookkeeping after the run started: the start
    // already succeeded, so a store hiccup must not fail the command.
    await updateBacklogStatus({ workspaceRoot: workspacePath, relativePath, status: 'in_progress' })
    await updateBacklogModuleMetadata({
      workspaceRoot: workspacePath,
      relativePath,
      moduleId: 'mobile-companion',
      value: {
        startedAt: this.now().toISOString(),
        commandId: command.commandId,
        deviceId: command.deviceId,
        teamName,
      },
    })

    return result
  }

  private async executeBacklogCreateCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.create' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
    })
    const title = command.payload.title.trim()
    if (!title) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'Backlog item creation requires a non-empty title.', false, undefined, undefined, workspacePath)
    }

    const result = await createBacklogItem({
      workspaceRoot: workspacePath,
      title,
      ...(command.payload.description !== undefined ? { description: command.payload.description } : {}),
      ...(command.payload.type !== undefined ? { type: command.payload.type } : {}),
      ...(command.payload.difficulty !== undefined ? { difficulty: command.payload.difficulty } : {}),
      ...(command.payload.criticality !== undefined ? { criticality: command.payload.criticality } : {}),
    })
    if (!result.ok) {
      return this.resultRecorder.reject(command, 'invalid_payload', result.message, false, undefined, undefined, workspacePath)
    }

    const item = result.store.items.find((record) => record.source.relativePath === result.relativePath) ?? null
    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      { id: result.id, relativePath: result.relativePath, item },
      workspacePath,
      'Mobile backlog item was created in the workspace backlog store.'
    )
  }

  private commandScope(options: MobileSprintEngineCommandDispatchOptions): MobileSprintEngineCommandScope {
    const configuredStates = this.configuredStatePaths.map((statePath) => validateSprintEngineStatePath(statePath))
    const dispatchStates = (options.statePaths ?? []).map((statePath) => validateSprintEngineStatePath(statePath))
    const statePaths = uniqueResolved([...configuredStates, ...dispatchStates].map((state) => state.statePath))
    const allowedWorkspaceRoots = uniqueResolved([
      ...this.configuredAllowedWorkspaceRoots,
      ...(options.allowedWorkspaceRoots ?? []),
    ])

    return { allowedWorkspaceRoots, statePaths }
  }

  private async resolveStateForSprintEngine(
    sprintEngineId: string,
    scope: MobileSprintEngineCommandScope
  ): Promise<ValidSprintEngineStatePath> {
    return resolveStateForSprintEngine({
      sprintEngineId,
      statePaths: scope.statePaths,
      workspaceRoot: this.workspaceRoot,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
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
