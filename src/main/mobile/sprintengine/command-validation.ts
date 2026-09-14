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
const worktreeIsolationValues = new Set(['required', 'preferred', 'disabled'])
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

// Mirrors validateSprintEngineCreateConfig in the shared protocol
// (packages/mobile-control-protocol/src/index.ts) — same bounds, desktop-side gate.
const sprintEngineTeamNameMaxChars = 64
const sprintEngineRoleCountMax = 10
const sprintEngineRosterMaxRoles = 12

function validateSprintEngineCreateConfig(payload: Record<string, unknown>): string | null {
  const config = payload.config
  if (config === undefined) return null
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return 'config must be an object'
  }

  const record = config as Record<string, unknown>

  if (record.teamName !== undefined) {
    if (typeof record.teamName !== 'string' || record.teamName.trim().length === 0) {
      return 'config.teamName must be a non-empty string'
    }
    if (record.teamName.trim().length > sprintEngineTeamNameMaxChars) {
      return `config.teamName must be ${sprintEngineTeamNameMaxChars} characters or less`
    }
  }

  if (record.roleCounts !== undefined) {
    if (typeof record.roleCounts !== 'object' || record.roleCounts === null || Array.isArray(record.roleCounts)) {
      return 'config.roleCounts must be an object of role id to seat count'
    }
    const entries = Object.entries(record.roleCounts as Record<string, unknown>)
    if (entries.length === 0) {
      return 'config.roleCounts must name at least one role when present'
    }
    if (entries.length > sprintEngineRosterMaxRoles) {
      return `config.roleCounts must name ${sprintEngineRosterMaxRoles} roles or fewer`
    }
    for (const [role, count] of entries) {
      if (role.trim().length === 0) {
        return 'config.roleCounts role ids must be non-empty'
      }
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > sprintEngineRoleCountMax) {
        return `config.roleCounts values must be integers from 1 to ${sprintEngineRoleCountMax}`
      }
    }
  }

  return null
}

function validateCommandPayload(type: MobileControlCommandType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case 'sprintengine.create':
      return (
        requireString(payload, 'workspacePath') ??
        requireString(payload, 'productPrompt') ??
        // Tolerated for older clients; never read.
        optionalString(payload, 'requestedRole') ??
        validateSprintEngineCreateConfig(payload)
      )
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
      return (
        requireString(payload, 'workspacePath') ??
        requireString(payload, 'relativePath') ??
        validateSprintEngineCreateConfig(payload)
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
    case 'sprintengine.openPullRequest':
      return requireString(payload, 'sprintEngineId')
    case 'sprintengine.setAutomationMode':
      return requireString(payload, 'sprintEngineId') ?? requireOneOf(payload, 'mode', automationModeValues)
    case 'automations.control':
      return (
        requireString(payload, 'workspacePath') ??
        requireString(payload, 'automationId') ??
        requireOneOf(payload, 'action', automationActionValues)
      )
  }
}

const automationModeValues = new Set(['manual', 'run_agents', 'run_agents_and_approve_artifacts'])

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
