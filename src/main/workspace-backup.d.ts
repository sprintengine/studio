import type { WorkspaceBackupPayload, WorkspaceBackupReadResult } from '../shared/electron-api';
export type WorkspaceBackupServiceDeps = {
    resolveUserDataDir: () => string;
};
export declare class WorkspaceBackupService {
    private readonly deps;
    private inFlightWrite;
    constructor(deps: WorkspaceBackupServiceDeps);
    private get backupPath();
    write(payload: WorkspaceBackupPayload): Promise<{
        ok: boolean;
        message?: string;
    }>;
    read(): Promise<WorkspaceBackupReadResult>;
}
export declare function createWorkspaceBackupService(deps: WorkspaceBackupServiceDeps): WorkspaceBackupService;
