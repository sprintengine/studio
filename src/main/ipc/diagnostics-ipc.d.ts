import { type IpcMain } from 'electron';
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../../shared/electron-api';
import { type TerminalRootInfo } from '../workspace-memory';
type DiagnosticsIpcDependencies = {
    writeDiagnosticLog(input: DiagnosticLogInput): Promise<DiagnosticLogEntry>;
    openDiagnosticsLogsFolder(): Promise<{
        opened: true;
        path: string;
    }>;
    openDiagnosticsWindow(): void;
    listConversationRoots?: () => TerminalRootInfo[];
};
export declare function registerDiagnosticsIpc(ipcMain: IpcMain, deps: DiagnosticsIpcDependencies): void;
export {};
