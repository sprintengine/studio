import type { AgentPhase } from '../shared/electron-api';
export declare const DEFAULT_SUSPEND_IDLE_AFTER_MS: number;
export declare const MIN_SUSPEND_IDLE_AFTER_MS: number;
export declare const MAX_SUSPEND_IDLE_AFTER_MS: number;
export declare function clampSuspendIdleAfterMs(value: unknown): number;
export declare const DEFAULT_KEEP_RECENT_TERMINALS_ALIVE = 3;
export declare const MIN_KEEP_RECENT_TERMINALS_ALIVE = 0;
export declare const MAX_KEEP_RECENT_TERMINALS_ALIVE = 20;
export declare function clampKeepRecentTerminalsAlive(value: unknown): number;
export type ReapCandidate = {
    sessionId: string;
    workspaceId: string | null;
    kind: string;
    cli: string | null;
    processAlive: boolean;
    agentPhase: AgentPhase | null;
    lastInteractionAt: number;
    idleSince: number | null;
    inActiveRun: boolean;
    sprintManaged: boolean;
    reapExempt: boolean;
    pendingWakeupAt: number | null;
};
export type ReapPolicyOptions = {
    now?: number;
    idleThresholdMs?: number;
    keepRecentAliveCount?: number;
};
export type ReapDecision = {
    reapableSessionIds: string[];
    heldByRecencyFloorSessionIds: string[];
};
export type ReapHold = 'dead_process' | 'not_agent' | 'no_workspace' | 'user_locked' | 'in_active_run' | 'pending_wakeup' | 'phase_awaiting_input' | 'phase_working' | 'phase_unrestful' | 'resting_recently';
export type ReapExplanation = {
    verdict: 'reapable';
    restingForMs: number;
} | {
    verdict: 'held';
    hold: ReapHold;
    restingForMs: number;
};
export declare function explainSessionReapDecision(candidate: ReapCandidate, options: {
    now: number;
    idleThresholdMs: number;
}): ReapExplanation;
export declare function isSessionReapable(candidate: ReapCandidate, options: {
    now: number;
    idleThresholdMs: number;
}): boolean;
export declare function selectReapableSessions(candidates: readonly ReapCandidate[], options?: ReapPolicyOptions): ReapDecision;
