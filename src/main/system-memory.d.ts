import type { SystemMemorySample } from '../shared/electron-api';
export declare const SYSTEM_MEMORY_SAMPLE_THROTTLE_MS = 5000;
export type SystemMemoryDeps = {
    platform?: NodeJS.Platform;
    totalBytes?: number;
    runVmStat?: () => Promise<string>;
    runSwapUsage?: () => Promise<string>;
    readMemInfo?: () => Promise<string>;
};
export declare function parseDarwinVmStat(vmStat: string, swapUsage: string, totalBytes: number): SystemMemorySample | null;
export declare function parseLinuxMemInfo(memInfo: string, totalBytes: number): SystemMemorySample | null;
export declare function sampleSystemMemory(deps?: SystemMemoryDeps): Promise<SystemMemorySample>;
