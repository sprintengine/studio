import { Buffer } from 'node:buffer';
import { randomUUID } from 'crypto';
import { relayCommandTypeToMobile } from './relay-command';
import { deepRedactLocalPaths } from '../sprintengine/relay-path-safety';
const mobileControlProtocolVersion = 2;
export const relayResultSummaryMaxBytes = 256 * 1024;
export function relaySummaryByteLength(value) {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}
export function acceptedBridgeCommand(command, data) {
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
    };
}
export function failedCommandResult(command, code, message) {
    const commandType = 'type' in command ? command.type : relayCommandTypeToMobile(command.commandType);
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
    };
}
export function summarizeCommandResult(result) {
    if (!result.ok) {
        return {
            ok: false,
            commandId: result.commandId,
            commandType: result.commandType,
            code: result.error.code,
            message: result.error.message,
            retryable: result.error.retryable,
            audit: summarizeAudit(result.audit),
        };
    }
    return {
        ok: true,
        commandId: result.commandId,
        commandType: result.commandType,
        executedAt: result.executedAt,
        data: sanitizeResultData(result.data),
        audit: summarizeAudit(result.audit),
    };
}
function summarizeAudit(audit) {
    return {
        auditId: audit.auditId,
        commandId: audit.commandId,
        deviceId: audit.deviceId,
        commandType: audit.commandType,
        status: audit.status,
        ...(audit.code ? { code: audit.code } : {}),
        ...(audit.artifactId ? { artifactId: audit.artifactId } : {}),
        ...(audit.exitCode !== undefined ? { exitCode: audit.exitCode } : {}),
        recordedAt: audit.recordedAt,
    };
}
function sanitizeResultData(data) {
    if (!data || typeof data !== 'object')
        return data;
    if (relaySummaryByteLength(data) > relayResultSummaryMaxBytes) {
        return { truncated: true };
    }
    // Universal backstop: every command result posted to the relay flows through
    // here, so redact any absolute local path the relay would otherwise reject.
    // Snapshot results are already tokenized upstream (sanitizeMobileSnapshotForRelay),
    // so this only ever strips stray display paths, never round-trip identifiers.
    return deepRedactLocalPaths(data);
}
