import { type PsProcessRow } from './child-process-metrics';
import type { TerminalKind, WorkspaceMemorySample } from '../shared/electron-api';
export declare const WORKSPACE_MEMORY_SAMPLE_THROTTLE_MS = 5000;
export type TerminalRootInfo = {
    sessionId: string;
    rootPid: number;
    workspaceId: string | null;
    agentId: string | null;
    terminalId: string | null;
    kind: TerminalKind;
    cli: string | null;
    activityKind: string;
    processAlive: boolean;
    startedAt: number;
};
export declare function sumSubtreeRssBytes(rootPid: number, rows: readonly PsProcessRow[]): number;
export declare function rollupWorkspaceMemory(roots: readonly TerminalRootInfo[], rows: readonly PsProcessRow[]): WorkspaceMemorySample[];
export type WorkspaceMemoryDeps = {
    platform?: NodeJS.Platform;
    runPs?: () => Promise<string>;
};
export declare function sampleWorkspaceMemory(roots: readonly TerminalRootInfo[], deps?: WorkspaceMemoryDeps): Promise<WorkspaceMemorySample[]>;
