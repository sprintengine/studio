import { randomUUID } from 'crypto'
import type {
  MobileControlCommand,
  MobileControlError,
  MobileSprintEngineCommandAuditEntry,
  MobileSprintEngineCommandResult,
} from './command'
import type { ValidSprintEngineStatePath } from './state-path'
import { buildError } from './command-validation'
import { redactToolArgs } from './tool-runner'

type MobileSprintEngineCommandAuditStatus = 'accepted' | 'rejected' | 'failed'

type MobileSprintEngineCommandAuditInput = {
  command?: MobileControlCommand
  status: MobileSprintEngineCommandAuditStatus
  code?: MobileControlError['code']
  message: string
  state?: ValidSprintEngineStatePath
  artifactId?: string
  workspacePath?: string
  toolArgs?: string[]
  exitCode?: number | null
}

export class MobileSprintEngineCommandResultRecorder {
  private readonly auditLog: MobileSprintEngineCommandAuditEntry[] = []

  constructor(
    private readonly now: () => Date,
    private readonly auditSink?: (entry: MobileSprintEngineCommandAuditEntry) => void
  ) {}

  getAuditLog(): MobileSprintEngineCommandAuditEntry[] {
    return [...this.auditLog]
  }

  acceptSessionCommand(
    command: MobileControlCommand,
    data: unknown,
    state: ValidSprintEngineStatePath,
    message: string
  ): MobileSprintEngineCommandResult {
    const audit = this.recordAudit({
      command,
      status: 'accepted',
      message,
      state,
    })

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
    }
  }

  acceptWorkspaceCommand(
    command: MobileControlCommand,
    data: unknown,
    workspacePath: string,
    message: string
  ): MobileSprintEngineCommandResult {
    const audit = this.recordAudit({
      command,
      status: 'accepted',
      message,
      workspacePath,
    })

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
    }
  }

  reject(
    command: MobileControlCommand,
    code: MobileControlError['code'],
    message: string,
    retryable: boolean,
    state?: ValidSprintEngineStatePath,
    artifactId?: string,
    workspacePath?: string,
    toolArgs?: string[],
    exitCode?: number | null
  ): MobileSprintEngineCommandResult {
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
    })

    return {
      ok: false,
      commandId: command.commandId,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      error: buildError(code, message, retryable),
      audit,
    }
  }

  rejectUnknown(error: MobileControlError): MobileSprintEngineCommandResult {
    const audit = this.recordAudit({
      status: 'rejected',
      code: error.code,
      message: error.message,
    })

    return {
      ok: false,
      commandId: null,
      commandType: 'unknown',
      error,
      audit,
    }
  }

  recordAudit(input: MobileSprintEngineCommandAuditInput): MobileSprintEngineCommandAuditEntry {
    const entry: MobileSprintEngineCommandAuditEntry = {
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
    }

    this.auditLog.unshift(entry)
    this.auditSink?.(entry)
    return entry
  }
}
