import type { IpcMain } from 'electron';
import type { WorkspaceBackupPayload, WorkspaceBackupReadResult, WorkspaceBackupWriteResult } from '../../shared/electron-api';
export type WorkspaceBackupBridge = {
    write(payload: WorkspaceBackupPayload): Promise<WorkspaceBackupWriteResult>;
    read(): Promise<WorkspaceBackupReadResult>;
};
export declare function registerWorkspaceBackupIpc(ipcMain: IpcMain, backup: WorkspaceBackupBridge): void;
