import type { IpcMain } from 'electron';
type IpcDiagnostics = {
    enabled: boolean;
    logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void;
    withIpcDiagnostics<T>(scope: string, event: string, payload: Record<string, unknown>, action: () => Promise<T>): Promise<T>;
};
export declare function registerGitIpc(ipcMain: IpcMain, diagnostics: IpcDiagnostics): void;
export {};
