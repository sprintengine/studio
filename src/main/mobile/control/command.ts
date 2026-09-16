import { resolve } from 'path'
import {
  idempotencyKeyForCommand,
  rememberedCommandResult,
  rememberCommandResult,
  requestHashFor,
} from './command-cache'
import { validateMobileControlCommand } from './command-validation'
import { uniqueResolved } from './path-utils'
import {
  getMobileControlCommandErrorMessage,
  MobileControlCommandError,
} from './command-error'
import { MobileControlCommandResultRecorder } from './command-results'
import { validateMobileWorkspacePath } from './workspace'
import { assertBacklogRelativePath } from './backlog'
import {
  createBacklogItem,
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

export { MobileControlCommandError } from './command-error'

// Wire schema is owned by packages/mobile-control-protocol/src/index.ts. Import the
// command types from there and re-export them so this module stays the public
// surface for consumers, without re-declaring (and risking drift from) the
// protocol. Adding a new command type is an edit to protocol.ts alone.
export { mobileControlProtocolVersion } from '../../../../packages/mobile-control-protocol/src/index'

import type {
  MobileControlCommand,
  MobileControlCommandType,
  MobileControlError,
} from '../../../../packages/mobile-control-protocol/src/index'

export type { MobileControlCommand, MobileControlCommandType, MobileControlError }

// The desktop's automations seam for `automations.control` (item 47). Narrow on
// purpose: the engine's own types carry trigger/action config — provider-owned
// `unknown` that can hold local paths and webhook secrets — and NONE of that may
// reach a command result, which the relay rejects outright if it contains a local
// path (multiauth result-summary.ts). So the adapter hands back only what the
// phone asked about.
type MobileAutomationControlRequest = {
  workspaceRoot: string
  automationId: string
  deviceId: string
  commandId: string
}

export type MobileAutomationControlResult =
  | { ok: true; value: MobileAutomationControlAccepted }
  // `code` is the engine's / write core's own rejection code, mapped onto the
  // mobile error vocabulary by mobileAutomationError below. The adapter must not
  // pre-judge it: the engine is the authority on what it will refuse.
  | { ok: false; error: { code: string; message: string } }

type MobileAutomationControlAccepted = {
  automationId: string
  status: 'enabled' | 'paused' | 'blocked'
  runId?: string
  runStatus?: string
}

export type MobileAutomationsController = {
  setStatus(request: MobileAutomationControlRequest & { status: 'enabled' | 'paused' }): Promise<MobileAutomationControlResult>
  runNow(request: MobileAutomationControlRequest): Promise<MobileAutomationControlResult>
}

const defaultCommandTtlMs = 30_000

/**
 * The mutations this service executes.
 *
 * The Sprint Engine's nine mobile commands left with the engine (MC-2575). They
 * are still members of the protocol's command union, and a phone that predates
 * the cut will keep sending them, so they are answered here — through the same
 * audited `command_not_supported` rejection every unexecutable command gets —
 * rather than being dropped on the floor or throwing.
 */
const allowedCommandTypes = new Set<MobileControlCommandType>([
  'backlog.update',
  'backlog.create',
  'automations.control',
])

// How the automations engine's rejections reach the phone. Every one of them is
// SURFACED, never swallowed: the engine is the authority on what it will refuse
// (a non-schedule trigger, a run already in flight), and a command the desktop
// refused must say so rather than report a success the user cannot see.
//
// Mapped onto the existing vocabulary rather than extended with automation-shaped
// codes, because MobileControlErrorCode is a CLOSED union the client validates
// (`isOneOf(errorCodes)`, protocol.ts) — unlike `snapshot.commands`, which is
// `string[]` precisely so it CAN grow. A new error code would be rejected by an
// already-paired phone's own validator, turning a rejection it should have shown
// the user into a result it cannot parse at all.
function mobileAutomationError(code: string): { code: MobileControlError['code']; retryable: boolean } {
  switch (code) {
    // engine.runNow: the trigger is not `schedule`. No retry will ever help.
    case 'unsupported_trigger':
    // The write core refuses a definition whose provider this desktop cannot honour
    // (definition-write.ts prepareDefinitionForWrite) — a missing integration, or a
    // provider no module registers. This is the `blocked` status' own cause, so it is
    // exactly what the phone hits when it enables a blocked automation, and
    // `invalid_schedule` is the same shape: the automation cannot run AS CONFIGURED
    // on this desktop. None of them is a fault the user can retry away, and none is
    // an internal error — reporting them as one would say "something broke" when the
    // truth is "this desktop cannot do that with this automation". The provider's own
    // reason ("Requires the <name> module") rides along in the message.
    case 'provider_blocked':
    case 'unknown_trigger':
    case 'unknown_action':
    case 'invalid_schedule':
      return { code: 'command_not_supported', retryable: false }
    // engine.runNow: a run is already going. This same command succeeds once it ends.
    case 'in_flight':
      return { code: 'task_not_ready', retryable: true }
    // The phone acted on a snapshot naming an automation the desktop no longer has.
    case 'missing':
      return { code: 'stale_snapshot', retryable: false }
    // The automations module is not loaded on this desktop build.
    case 'automations_unavailable':
      return { code: 'command_not_supported', retryable: false }
    // The front door's own gate (definition-write.ts validateKnownWorkspaceRoot):
    // the automations store is only reachable for a workspace the desktop actually
    // has open. A root that survives the mobile scope check can still fail this
    // one, and refusing to touch the folder is exactly what path_not_allowed says.
    case 'workspace_root_untrusted':
    case 'workspace_root_unverified':
      return { code: 'path_not_allowed', retryable: false }
    case 'invalid_input':
      return { code: 'invalid_payload', retryable: false }
    // Store failures, an invalid schedule, a failed next-run recompute: real
    // desktop-side faults the phone cannot act on beyond seeing the message.
    default:
      return { code: 'internal_error', retryable: false }
  }
}

type MobileControlCommandServiceOptions = {
  workspaceRoot?: string
  allowedWorkspaceRoots?: string[]
  commandTtlMs?: number
  now?: () => Date
  automationsController?: MobileAutomationsController
  auditSink?: (entry: MobileControlCommandAuditEntry) => void
}

export type MobileControlCommandDispatchOptions = {
  allowedWorkspaceRoots?: string[]
}

type MobileControlCommandScope = {
  allowedWorkspaceRoots: string[]
}

export type MobileControlCommandAuditEntry = {
  auditId: string
  commandId: string
  commandType: MobileControlCommandType | 'unknown'
  deviceId: string | null
  idempotencyKey?: string
  status: 'accepted' | 'rejected'
  code?: MobileControlError['code']
  message: string
  recordedAt: string
  workspacePath?: string
}

export type MobileControlCommandResult =
  | {
      ok: true
      commandId: string
      commandType: MobileControlCommandType
      idempotencyKey?: string
      executedAt: string
      data: unknown
      stdout: string
      stderr: string
      audit: MobileControlCommandAuditEntry
    }
  | {
      ok: false
      commandId: string | null
      commandType: MobileControlCommandType | 'unknown'
      idempotencyKey?: string
      error: MobileControlError
      audit: MobileControlCommandAuditEntry
    }

export class MobileControlCommandService {
  private readonly workspaceRoot: string
  private readonly configuredAllowedWorkspaceRoots: string[]
  private readonly commandTtlMs: number
  private readonly now: () => Date
  private readonly automationsController?: MobileAutomationsController
  private readonly resultRecorder: MobileControlCommandResultRecorder

  constructor(options: MobileControlCommandServiceOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
    this.configuredAllowedWorkspaceRoots = uniqueResolved([
      this.workspaceRoot,
      ...(options.allowedWorkspaceRoots ?? []),
    ])
    this.commandTtlMs = Math.max(1, options.commandTtlMs ?? defaultCommandTtlMs)
    this.now = options.now ?? (() => new Date())
    this.automationsController = options.automationsController
    this.resultRecorder = new MobileControlCommandResultRecorder(this.now, options.auditSink)
  }

  getAuditLog(): MobileControlCommandAuditEntry[] {
    return this.resultRecorder.getAuditLog()
  }

  async dispatch(input: unknown, options: MobileControlCommandDispatchOptions = {}): Promise<MobileControlCommandResult> {
    const validated = validateMobileControlCommand(input)
    if (!validated.ok) {
      return this.resultRecorder.rejectUnknown(validated.error)
    }

    const command = validated.value
    if (!allowedCommandTypes.has(command.type)) {
      return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not available on this desktop.`, false)
    }

    if (!command.idempotencyKey) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'idempotencyKey is required for mobile mutation commands.', false)
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
      if (error instanceof MobileControlCommandError) {
        const result = this.resultRecorder.reject(command, error.code, error.message, error.retryable)
        rememberCommandResult(idempotencyKey, requestHash, result)
        return result
      }
      const result = this.resultRecorder.reject(command, 'internal_error', getMobileControlCommandErrorMessage(error), false)
      rememberCommandResult(idempotencyKey, requestHash, result)
      return result
    }
  }

  private async executeCommand(
    command: MobileControlCommand,
    scope: MobileControlCommandScope
  ): Promise<MobileControlCommandResult> {
    switch (command.type) {
      case 'backlog.update':
        return this.executeBacklogUpdateCommand(command, scope)
      case 'backlog.create':
        return this.executeBacklogCreateCommand(command, scope)
      case 'automations.control':
        return this.executeAutomationsControlCommand(command, scope)
      // Everything `allowedCommandTypes` already refused, restated so the switch
      // stays exhaustive over the protocol's union — the compiler, not a reader,
      // is what keeps a new command type from falling through here silently.
      // Both are read elsewhere: `snapshot.request` is answered by the bridge's
      // snapshot dispatcher and `device.revoke` by its revoke path, before either
      // reaches the command service.
      case 'snapshot.request':
      case 'device.revoke':
        return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not available on this desktop.`, false)
    }
  }

  private async executeAutomationsControlCommand(
    command: Extract<MobileControlCommand, { type: 'automations.control' }>,
    scope: MobileControlCommandScope
  ): Promise<MobileControlCommandResult> {
    if (!this.automationsController) {
      return this.resultRecorder.reject(
        command,
        'command_not_supported',
        'Controlling automations is not supported by this desktop build.',
        false
      )
    }

    // The phone sends the `ws_…` token it read off the automation's projectKey —
    // absolute paths never cross the relay — so resolve it back to a root this
    // desktop already knows, and fail closed with path_not_allowed otherwise.
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })

    const { automationId, action } = command.payload
    const request: MobileAutomationControlRequest = {
      workspaceRoot: workspacePath,
      automationId,
      deviceId: command.deviceId,
      commandId: command.commandId,
    }

    const result = action === 'runNow'
      ? await this.automationsController.runNow(request)
      : await this.automationsController.setStatus({
        ...request,
        status: action === 'enable' ? 'enabled' : 'paused',
      })

    if (!result.ok) {
      const { code, retryable } = mobileAutomationError(result.error.code)
      return this.resultRecorder.reject(command, code, result.error.message, retryable, workspacePath)
    }

    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      result.value,
      workspacePath,
      'Mobile automation control was applied by the desktop automations engine.'
    )
  }

  private async executeBacklogUpdateCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.update' }>,
    scope: MobileControlCommandScope
  ): Promise<MobileControlCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })
    const relativePath = assertBacklogRelativePath(command.payload.relativePath)
    const { status, type, difficulty, criticality } = command.payload
    if (status === undefined && type === undefined && difficulty === undefined && criticality === undefined) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'Backlog updates require at least one of status, type, difficulty, or criticality.', false, workspacePath)
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
        return this.resultRecorder.reject(command, 'invalid_payload', result.message, false, workspacePath)
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

  private async executeBacklogCreateCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.create' }>,
    scope: MobileControlCommandScope
  ): Promise<MobileControlCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })
    const title = command.payload.title.trim()
    if (!title) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'Backlog item creation requires a non-empty title.', false, workspacePath)
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
      return this.resultRecorder.reject(command, 'invalid_payload', result.message, false, workspacePath)
    }

    const item = result.store.items.find((record) => record.source.relativePath === result.relativePath) ?? null
    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      { id: result.id, relativePath: result.relativePath, item },
      workspacePath,
      'Mobile backlog item was created in the workspace backlog store.'
    )
  }

  private commandScope(options: MobileControlCommandDispatchOptions): MobileControlCommandScope {
    const allowedWorkspaceRoots = uniqueResolved([
      ...this.configuredAllowedWorkspaceRoots,
      ...(options.allowedWorkspaceRoots ?? []),
    ])

    return { allowedWorkspaceRoots }
  }

  // Roots a phone-supplied workspace token may resolve to. Token resolution is
  // still re-validated against allowedWorkspaceRoots, so this set can never
  // relax the security boundary.
  private workspaceRootCandidates(scope: MobileControlCommandScope): string[] {
    return uniqueResolved(scope.allowedWorkspaceRoots)
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
  ): MobileControlCommandResult | null {
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
      message: 'Mobile command result was replayed for a matching idempotency key.',
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
