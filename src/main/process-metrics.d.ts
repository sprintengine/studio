import type { ProcessMetricSample, ProcessMetricsSnapshot } from '../shared/electron-api';
export type RawProcessMetric = {
    pid: number;
    type: string;
    name?: string;
    serviceName?: string;
    cpu?: {
        percentCPUUsage?: number;
    };
    memory?: {
        workingSetSize?: number;
    };
};
export type MainHeapUsage = {
    pid: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
};
export declare function collectProcessMetrics(getAppMetrics: () => RawProcessMetric[], now?: number, mainHeap?: MainHeapUsage, threadCounts?: ReadonlyMap<number, number>, childProcesses?: readonly ProcessMetricSample[]): ProcessMetricsSnapshot;
