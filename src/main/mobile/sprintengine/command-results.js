import { randomUUID } from 'crypto';
import { buildError } from './command-validation';
import { redactToolArgs } from './tool-runner';
export class MobileSprintEngineCommandResultRecorder {
    now;
    auditSink;
    auditLog = [];
    constructor(now, auditSink) {
        this.now = now;
        this.auditSink = auditSink;
    }
    getAuditLog() {
        return [...this.auditLog];
    }
    acceptSessionCommand(command, data, state, message) {
        const audit = this.recordAudit({
            command,
            status: 'accepted',
            message,
            state,
        });
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
        };
    }
    acceptWorkspaceCommand(command, data, workspacePath, message) {
        const audit = this.recordAudit({
            command,
            status: 'accepted',
            message,
            workspacePath,
        });
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
        };
    }
    reject(command, code, message, retryable, state, artifactId, workspacePath, toolArgs, exitCode) {
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
        });
        return {
            ok: false,
            commandId: command.commandId,
            commandType: command.type,
            idempotencyKey: command.idempotencyKey,
            error: buildError(code, message, retryable),
            audit,
        };
    }
    rejectUnknown(error) {
        const audit = this.recordAudit({
            status: 'rejected',
            code: error.code,
            message: error.message,
        });
        return {
            ok: false,
            commandId: null,
            commandType: 'unknown',
            error,
            audit,
        };
    }
    recordAudit(input) {
        const entry = {
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
        };
        this.auditLog.unshift(entry);
        this.auditSink?.(entry);
        return entry;
    }
}
