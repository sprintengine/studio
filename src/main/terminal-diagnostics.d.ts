import type { TerminalSession } from './terminal-session';
import type { SessionActivity } from '../shared/electron-api';
type TerminalDiagnosticCause = 'timer' | 'exit' | 'dispose' | 'visibility';
type TerminalDiagnosticsOptions = {
    enabled: boolean;
    logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void;
};
export declare function createTerminalDiagnostics({ enabled, logMainPerfEvent }: TerminalDiagnosticsOptions): {
    recordDataBatch: (session: TerminalSession | undefined, cause: TerminalDiagnosticCause, chunkCount: number, byteCount: number) => void;
    recordInputWrite: (session: TerminalSession | undefined, byteCount: number, elapsedMs: number, ok: boolean) => void;
    recordActivityTransition: (session: TerminalSession | undefined, previousActivity: SessionActivity, nextActivity: SessionActivity) => void;
    clear: (sessionId: string) => void;
};
export {};
