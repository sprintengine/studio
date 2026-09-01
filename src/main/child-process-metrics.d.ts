import type { ProcessMetricKind, ProcessMetricSample } from '../shared/electron-api';
export declare const CHILD_PROCESS_SAMPLE_THROTTLE_MS = 5000;
export type PsProcessRow = {
    pid: number;
    ppid: number;
    rssKb: number;
    cpuPercent: number;
    command: string;
    args: string;
};
type ChildProcessClassification = {
    kind: ProcessMetricKind;
    name: string;
};
export type ChildProcessMetricDeps = {
    platform?: NodeJS.Platform;
    runPs?: () => Promise<string>;
};
export declare function parsePsProcessRows(stdout: string): PsProcessRow[];
export declare function classifyChildProcess(row: PsProcessRow): ChildProcessClassification;
export declare function collectChildProcessMetrics(rows: readonly PsProcessRow[], rootPid: number, excludedPids: ReadonlySet<number>): ProcessMetricSample[];
export declare function sampleChildProcessMetrics(rootPid: number, excludedPids: readonly number[], deps?: ChildProcessMetricDeps): Promise<ProcessMetricSample[]>;
export {};
