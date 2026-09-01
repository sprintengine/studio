import { type TokenUsageDeps } from './sprintengine-token-usage';
export declare function sprintTokenUsageDeps(): TokenUsageDeps;
type SprintSessionIdentity = {
    sprintEngineStatePath?: string;
    agentId?: string;
    sprintEngineRole?: string;
    cli?: string;
    cliSessionId?: string;
};
export declare function recordSprintSessionForTokenLedger(session: SprintSessionIdentity): void;
export declare function sampleSprintSessionTokenUsage(session: SprintSessionIdentity, reason: 'teardown' | 'session-end'): Promise<void>;
export {};
