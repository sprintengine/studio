// Straight from the protocol module rather than through `./command`, which
// re-exports it: this is a value import, and `./command` imports this file back.
import {
  isSupportedMobileControlProtocolVersion,
  mobileControlProtocolVersion,
  unsupportedMobileControlProtocolVersion,
} from '../../../../packages/mobile-control-protocol/src/index'
import type {
  MobileControlCommand,
  MobileControlCommandType,
  MobileControlError,
} from './command'

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MobileControlError }

// Every command type on the wire, including the nine the Sprint Engine took with
// it (MC-2575). A paired phone ships on its own release train and will keep
// sending them, and the honest answer to one is `command_not_supported` from the
// command service — not `invalid_payload` from the envelope validator, which
// would tell its owner the phone had sent something malformed.
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
  'backlog.create',
  'sprintengine.openPullRequest',
  'sprintengine.setAutomationMode',
  'automations.control',
])
const automationActionValues = new Set(['enable', 'pause', 'runNow'])

export function validateMobileControlCommand(input: unknown): ValidationResult<MobileControlCommand> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: buildError('invalid_payload', 'command must be an object', false) }
  }

  const command = input as Record<string, unknown>
  // The window, not equality: a phone one release behind still drives this
  // desktop. The refusal outside it is unchanged, and still names the code a
  // client branches on.
  if (!isSupportedMobileControlProtocolVersion(command.protocolVersion)) {
    return {
      ok: false,
      error: buildError(
        'unsupported_protocol_version',
        unsupportedMobileControlProtocolVersion(command.protocolVersion),
        false
      ),
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
    // Retired with the Sprint Engine (MC-2575). Their payloads are no longer
    // shaped by anything on this desktop, so there is nothing left to check
    // beyond the envelope: the command service refuses them by type.
    case 'sprintengine.create':
    case 'artifact.approve':
    case 'artifact.requestChanges':
    case 'artifact.read':
    case 'task.start':
    case 'agent.followUp':
    case 'backlog.startSprintEngine':
    case 'sprintengine.openPullRequest':
    case 'sprintengine.setAutomationMode':
      return null
    case 'snapshot.request':
      return optionalString(payload, 'sprintEngineId')
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
    case 'backlog.create':
      return (
        requireString(payload, 'workspacePath') ??
        requireString(payload, 'title') ??
        optionalString(payload, 'description') ??
        optionalString(payload, 'type') ??
        optionalString(payload, 'difficulty') ??
        optionalString(payload, 'criticality')
      )
    case 'automations.control':
      return (
        requireString(payload, 'workspacePath') ??
        requireString(payload, 'automationId') ??
        requireOneOf(payload, 'action', automationActionValues)
      )
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
