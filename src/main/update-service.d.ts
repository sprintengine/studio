import type { AppUpdateCheckResult, AppUpdateState, DiagnosticLogEntry, DiagnosticLogInput } from '../shared/electron-api';
type WriteDiagnosticLog = (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>;
type UpdateServiceOptions = {
    writeDiagnosticLog: WriteDiagnosticLog;
};
export declare class MulticodeUpdateService {
    private readonly writeDiagnosticLog;
    private state;
    constructor({ writeDiagnosticLog }: UpdateServiceOptions);
    getState(): AppUpdateState;
    checkForUpdates(isManual?: boolean): Promise<AppUpdateCheckResult>;
    downloadUpdate(): Promise<AppUpdateCheckResult>;
    quitAndInstall(): AppUpdateCheckResult;
    openReleaseNotes(): Promise<{
        opened: true;
        url: string;
    }>;
    private registerAutoUpdaterEvents;
    private updateState;
    private logUpdateError;
}
export {};
