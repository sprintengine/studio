import type { AgentCli, AgentExecutionMode, TerminalKind } from '../shared/electron-api';
export declare const TERMINAL_SNAPSHOT_SIDECAR_DIR_NAME = "terminal-snapshots";
export declare const TERMINAL_SNAPSHOT_SIDECAR_TTL_MS: number;
export type TerminalSnapshotSidecar = {
    version: 1;
    sessionId: string;
    savedAt: number;
    cols: number;
    rows: number;
    kind: TerminalKind;
    workspaceId?: string;
    agentId?: string;
    terminalId?: string;
    cli?: AgentCli;
    cliSessionId?: string;
    cwd?: string;
    executionMode?: AgentExecutionMode;
    worktreeId?: string;
    worktreePath?: string;
    snapshot?: string;
    rawReplay?: string;
};
export type TerminalSnapshotSidecarStore = {
    read(sessionId: string): TerminalSnapshotSidecar | null;
    write(sidecar: TerminalSnapshotSidecar): void;
    remove(sessionId: string): void;
    sweepExpired(now?: number): string[];
};
export declare function createTerminalSnapshotSidecarStore(options: {
    resolveUserDataDir: () => string;
    ttlMs?: number;
    logDiagnostic?: (diagnostic: {
        level: 'warning';
        title: string;
        message: string;
        details?: string;
    }) => void;
}): TerminalSnapshotSidecarStore;
