import type {
  MobileControlCommand,
  MobileControlCommandType,
  MobileControlError,
} from './command'

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MobileControlError }

const mobileControlProtocolVersion = 1 as const

const commandTypes = new Set<MobileControlCommandType>([
  'snapshot.request',
  'artifact.read',
  'sprintengine.create',
  'task.start',
  'artifact.approve',
  'artifact.requestChanges',
  'agent.followUp',
  'device.revoke',
  'backlog.update',
  'backlog.startSprintEngine',
])
const worktreeIsolationValues = new Set(['required', 'preferred', 'disabled'])

export function validateMobileControlCommand(input: unknown): ValidationResult<MobileControlCommand> {
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

export function buildError(code: MobileControlError['code'], message: string, retryable: boolean): MobileControlError {
  return {
    protocolVersion: mobileControlProtocolVersion,
    code,
    message,
    retryable,
  }
}

function validateCommandPayload(type: MobileControlCommandType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case 'sprintengine.create':
      return requireString(payload, 'workspacePath') ?? requireString(payload, 'productPrompt') ?? optionalString(payload, 'requestedRole')
    case 'artifact.approve':
      return requireString(payload, 'sprintEngineId') ?? requireString(payload, 'artifactId') ?? optionalString(payload, 'feedback')
    case 'artifact.requestChanges':
      return requireString(payload, 'sprintEngineId') ?? requireString(payload, 'artifactId') ?? requireString(payload, 'feedback')
    case 'snapshot.request':
      return optionalString(payload, 'sprintEngineId')
    case 'artifact.read':
      return requireString(payload, 'sprintEngineId') ?? requireString(payload, 'artifactId') ?? requireString(payload, 'previewMode')
    case 'task.start':
      return (
        requireString(payload, 'sprintEngineId') ??
        requireString(payload, 'taskId') ??
        requireString(payload, 'role') ??
        requireOneOf(payload, 'worktreeIsolation', worktreeIsolationValues)
      )
    case 'agent.followUp':
      return requireString(payload, 'sprintEngineId') ?? requireString(payload, 'agentId') ?? requireString(payload, 'text')
    case 'device.revoke':
      return requireString(payload, 'deviceId') ?? optionalString(payload, 'reason')
    case 'backlog.update':
      return (
        requireString(payload, 'workspacePath') ??
        requireString(payload, 'relativePath') ??
        optionalString(payload, 'status') ??
        optionalString(payload, 'type') ??
        optionalString(payload, 'difficulty') ??
        optionalString(payload, 'criticality')
      )
    case 'backlog.startSprintEngine':
      return requireString(payload, 'workspacePath') ?? requireString(payload, 'relativePath')
  }
}

function requireString(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === 'string' && record[field].length > 0 ? null : `${field} must be a non-empty string`
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || (typeof record[field] === 'string' && record[field].length > 0)
    ? null
    : `${field} must be a non-empty string when provided`
}

function requireOneOf(record: Record<string, unknown>, field: string, allowed: Set<string>): string | null {
  return typeof record[field] === 'string' && allowed.has(record[field]) ? null : `${field} must be one of: ${Array.from(allowed).join(', ')}`
}

function requireIsoDate(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return `${field} must be an ISO 8601 timestamp`
  }
  return null
}
