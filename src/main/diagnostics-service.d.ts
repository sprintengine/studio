import type { DiagnosticLogEntry, DiagnosticLogInput } from '../shared/electron-api';
export declare function writeDiagnosticLog(input: DiagnosticLogInput): Promise<DiagnosticLogEntry>;
export declare function openDiagnosticsLogsFolder(): Promise<{
    opened: true;
    path: string;
}>;
