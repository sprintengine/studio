import { Buffer } from 'node:buffer'
import { randomUUID } from 'crypto'
import type {
  MobileControlCommand,
  MobileControlCommandAuditEntry,
  MobileControlCommandResult,
} from '../control/command'
import type {
  MobileControlErrorCode,
  RelayCommandEnvelope,
} from './index'
import { relayCommandTypeToMobile } from './relay-command'
import { deepRedactLocalPaths } from '../control/relay-path-safety'

const mobileControlProtocolVersion = 2 as const
export const relayResultSummaryMaxBytes = 256 * 1024

export function relaySummaryByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

export function acceptedBridgeCommand(
  command: MobileControlCommand,
  data: unknown
): Extract<MobileControlCommandResult, { ok: true }> {
  return {
    ok: true,
    commandId: command.commandId,
    commandType: command.type,
    idempotencyKey: command.idempotencyKey,
    executedAt: new Date().toISOString(),
    data,
    stdout: '',
    stderr: '',
    audit: {
      auditId: `msa_${randomUUID()}`,
      commandId: command.commandId,
      commandType: command.type,
      deviceId: command.deviceId,
      ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
      status: 'accepted',
      message: 'Mobile relay command was handled by the desktop bridge.',
      recordedAt: new Date().toISOString(),
    },
  }
}

export function failedCommandResult(
  command: Pick<MobileControlCommand, 'commandId' | 'type' | 'idempotencyKey'> | RelayCommandEnvelope,
  code: MobileControlErrorCode,
  message: string
): Extract<MobileControlCommandResult, { ok: false }> {
  const commandType = 'type' in command ? command.type : relayCommandTypeToMobile(command.commandType)
  return {
    ok: false,
    commandId: command.commandId,
    commandType,
    ...('idempotencyKey' in command && command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
    error: {
      protocolVersion: mobileControlProtocolVersion,
      code,
      message,
      retryable: code === 'relay_unavailable' || code === 'desktop_unavailable',
    },
    audit: {
      auditId: `msa_${randomUUID()}`,
      commandId: command.commandId,
      commandType,
      deviceId: null,
      status: 'rejected',
      code,
      message,
      recordedAt: new Date().toISOString(),
    },
  }
}

export function summarizeCommandResult(result: MobileControlCommandResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      ok: false,
      commandId: result.commandId,
      commandType: result.commandType,
      code: result.error.code,
      // The relay rejects the WHOLE summary if any string in it carries an
      // absolute local path, and a rejected post leaves the phone polling to
      // its timeout instead of seeing the error. So the message and the audit
      // are redacted exactly as data is, not only data.
      message: deepRedactLocalPaths(result.error.message),
      retryable: result.error.retryable,
      audit: deepRedactLocalPaths(summarizeAudit(result.audit)),
    }
  }

  return {
    ok: true,
    commandId: result.commandId,
    commandType: result.commandType,
    executedAt: result.executedAt,
    data: sanitizeResultData(result.data),
    audit: deepRedactLocalPaths(summarizeAudit(result.audit)),
  }
}

function summarizeAudit(audit: MobileControlCommandAuditEntry): Record<string, unknown> {
  return {
    auditId: audit.auditId,
    commandId: audit.commandId,
    deviceId: audit.deviceId,
    commandType: audit.commandType,
    status: audit.status,
    ...(audit.code ? { code: audit.code } : {}),
    recordedAt: audit.recordedAt,
  }
}

function sanitizeResultData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  if (relaySummaryByteLength(data) > relayResultSummaryMaxBytes) {
    return { truncated: true }
  }
  // Universal backstop: every command result posted to the relay flows through
  // here, so redact any absolute local path the relay would otherwise reject.
  // Snapshot results are already tokenized upstream (sanitizeMobileSnapshotForRelay),
  // so this only ever strips stray display paths, never round-trip identifiers.
  return deepRedactLocalPaths(data)
}
