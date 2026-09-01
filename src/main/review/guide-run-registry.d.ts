export type GuideRunPhase = 'reading' | 'grouping' | 'annotating' | 'writing' | 'done' | 'failed';
export interface GuideRunStatus {
    running: boolean;
    phase: GuideRunPhase;
    detail?: string;
    startedAt: string;
}
export interface GuideRunRecorder {
    record(phase: GuideRunPhase, detail?: string): boolean;
}
export declare class GuideRunRegistry {
    private readonly runs;
    private nextRunId;
    begin(reviewId: string, startedAt?: string): GuideRunRecorder;
    record(reviewId: string, phase: GuideRunPhase, detail?: string): void;
    status(reviewId: string): GuideRunStatus | null;
    private write;
}
export declare const guideRunRegistry: GuideRunRegistry;
