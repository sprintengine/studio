import { type ModelTokenUsage } from './types';
export type SprintTokenLedgerSessionRecord = {
    kind: 'session';
    agentId: string;
    role?: string;
    cli: string;
    cliSessionId: string;
    at: string;
};
export type SprintTokenLedgerSampleRecord = {
    kind: 'sample';
    agentId: string;
    cli: string;
    cliSessionId: string;
    measured: boolean;
    perModel: ModelTokenUsage[];
    sampledAt: string;
    reason: 'teardown' | 'session-end';
};
export type SprintTokenLedgerRecord = SprintTokenLedgerSessionRecord | SprintTokenLedgerSampleRecord;
export type SprintTokenLedgerSession = {
    agentId: string;
    role?: string;
    cli: string;
    cliSessionId: string;
    lastSample?: Pick<SprintTokenLedgerSampleRecord, 'measured' | 'perModel' | 'sampledAt'>;
};
export declare function tokenLedgerPath(statePath: string): string;
export declare function tokenLedgerVersion(statePath: string): number;
export declare function appendTokenLedgerRecord(statePath: string, record: SprintTokenLedgerRecord): Promise<void>;
export declare function readTokenLedger(statePath: string): Promise<SprintTokenLedgerSession[]>;
