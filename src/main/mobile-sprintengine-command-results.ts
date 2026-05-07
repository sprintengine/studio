import { randomUUID } from 'crypto'
import type {
  MobileControlCommand,
  MobileControlError,
  MobileSwarmCommandAuditEntry,
  MobileSwarmCommandResult,
} from './mobile-sprintengine-command'
import type { ValidSwarmStatePath } from './mobile-sprintengine-state-path'
import { buildError } from './mobile-sprintengine-command-validation'
import { redactToolArgs } from './mobile-sprintengine-tool-runner'

type MobileSwarmCommandAuditStatus = 'accepted' | 'rejected' | 'failed'

type MobileSwarmCommandAuditInput = {
  command?: MobileControlCommand
  status: MobileSwarmCommandAuditStatus
  code?: MobileControlError['code']
  message: string
  state?: ValidSwarmStatePath
  artifactId?: string
  workspacePath?: string
  toolArgs?: string[]
  exitCode?: number | null
}

export class MobileSwarmCommandResultRecorder {
  private readonly auditLog: MobileSwarmCommandAuditEntry[] = []

  constructor(
    private readonly now: () => Date,
    private readonly auditSink?: (entry: MobileSwarmCommandAuditEntry) => void
  ) {}

  getAuditLog(): MobileSwarmCommandAuditEntry[] {
    return [...this.auditLog]
  }

  acceptSessionCommand(
    command: MobileControlCommand,
    data: unknown,
    state: ValidSwarmStatePath,
    message: string
  ): MobileSwarmCommandResult {
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

  reject(
    command: MobileControlCommand,
    code: MobileControlError['code'],
    message: string,
    retryable: boolean,
    state?: ValidSwarmStatePath,
    artifactId?: string,
    workspacePath?: string,
    toolArgs?: string[],
    exitCode?: number | null
  ): MobileSwarmCommandResult {
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

  rejectUnknown(error: MobileControlError): MobileSwarmCommandResult {
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

  recordAudit(input: MobileSwarmCommandAuditInput): MobileSwarmCommandAuditEntry {
    const entry: MobileSwarmCommandAuditEntry = {
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
