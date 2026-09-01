import type { MobileControlCommand, MobileControlError, MobileSprintEngineCommandAuditEntry, MobileSprintEngineCommandResult } from './command';
import type { ValidSprintEngineStatePath } from './state-path';
type MobileSprintEngineCommandAuditStatus = 'accepted' | 'rejected' | 'failed';
type MobileSprintEngineCommandAuditInput = {
    command?: MobileControlCommand;
    status: MobileSprintEngineCommandAuditStatus;
    code?: MobileControlError['code'];
    message: string;
    state?: ValidSprintEngineStatePath;
    artifactId?: string;
    workspacePath?: string;
    toolArgs?: string[];
    exitCode?: number | null;
};
export declare class MobileSprintEngineCommandResultRecorder {
    private readonly now;
    private readonly auditSink?;
    private readonly auditLog;
    constructor(now: () => Date, auditSink?: ((entry: MobileSprintEngineCommandAuditEntry) => void) | undefined);
    getAuditLog(): MobileSprintEngineCommandAuditEntry[];
    acceptSessionCommand(command: MobileControlCommand, data: unknown, state: ValidSprintEngineStatePath, message: string): MobileSprintEngineCommandResult;
    acceptWorkspaceCommand(command: MobileControlCommand, data: unknown, workspacePath: string, message: string): MobileSprintEngineCommandResult;
    reject(command: MobileControlCommand, code: MobileControlError['code'], message: string, retryable: boolean, state?: ValidSprintEngineStatePath, artifactId?: string, workspacePath?: string, toolArgs?: string[], exitCode?: number | null): MobileSprintEngineCommandResult;
    rejectUnknown(error: MobileControlError): MobileSprintEngineCommandResult;
    recordAudit(input: MobileSprintEngineCommandAuditInput): MobileSprintEngineCommandAuditEntry;
}
export {};
