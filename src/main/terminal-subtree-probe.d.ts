export declare const SUBTREE_BUSY_CPU_PERCENT = 15;
export declare const CLAUDE_TOOL_SHELL_SIGNATURE = ".claude/shell-snapshots/";
export type ProcRow = {
    pid: number;
    ppid: number;
    cpuPercent: number;
    command: string;
};
export type SubtreeLiveReason = 'listening_port' | 'busy_cpu' | 'tool_shell';
export declare function parsePsTree(stdout: string): ProcRow[];
export declare function parseListeningPids(stdout: string): Set<number>;
export declare function subtreeLiveReason(rootPid: number, procs: readonly ProcRow[], listeningPids: ReadonlySet<number>, options?: {
    busyCpuPercent?: number;
}): SubtreeLiveReason | null;
export declare function subtreeHasLiveProcess(rootPid: number, procs: readonly ProcRow[], listeningPids: ReadonlySet<number>, options?: {
    busyCpuPercent?: number;
}): boolean;
export type SubtreeProbeDeps = {
    platform?: NodeJS.Platform;
    runPs?: () => Promise<string | null>;
    runLsofListening?: () => Promise<string | null>;
};
export declare function probeSubtreesForLiveWork(rootPids: readonly number[], deps?: SubtreeProbeDeps): Promise<Map<number, SubtreeLiveReason | null>>;
export declare function probeSubtreesForLiveProcesses(rootPids: readonly number[], deps?: SubtreeProbeDeps): Promise<Map<number, boolean>>;
export declare function matchCliSessionPids(psOutput: string, cliSessionId: string): number[];
/**
 * Post-teardown escalation: after the pty kill has had `delayMs` to propagate,
 * SIGKILL any process still carrying this terminal's `--session-id`. Callers
 * fire-and-forget it right after the kill; a clean exit means the ps sweep
 * finds nothing and this is a no-op. Returns the pids it killed (for tests
 * and audit).
 */
export declare function killCliSessionSurvivors(cliSessionId: string, deps?: SubtreeProbeDeps & {
    delayMs?: number;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<number[]>;
