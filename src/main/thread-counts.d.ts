export declare const THREAD_SAMPLE_THROTTLE_MS = 5000;
export declare function parsePsThreadCounts(stdout: string, requestedPids: ReadonlySet<number>): Map<number, number>;
export declare function parseProcStatusThreads(text: string): number | null;
export type ThreadCountDeps = {
    platform?: NodeJS.Platform;
    runPs?: (pids: readonly number[]) => Promise<string>;
    readProcStatus?: (pid: number) => Promise<string>;
};
export declare function sampleThreadCounts(pids: readonly number[], deps?: ThreadCountDeps): Promise<Map<number, number>>;
