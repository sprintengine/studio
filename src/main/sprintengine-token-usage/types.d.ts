import type { AgentCli } from '../../shared/electron-api';
import type { SprintEngineModelTokenUsage } from '../../shared/sprintengine-token-usage';
export type ModelTokenUsage = SprintEngineModelTokenUsage;
export type SessionTokenUsage = {
    cli: AgentCli;
    cliSessionId: string;
    measured: boolean;
    perModel: ModelTokenUsage[];
    sampledAt: string;
};
export type FetchResponseLike = {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
};
export type FetchLike = (url: string, init?: {
    headers?: Record<string, string>;
    redirect?: 'error' | 'follow' | 'manual';
}) => Promise<FetchResponseLike>;
export type TokenUsageDeps = {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => string;
    fetchImpl?: FetchLike;
    isClaudeHarnessCli?: (cli: string) => boolean;
};
export declare function emptyModelUsage(model: string): ModelTokenUsage;
export declare function tokenCount(value: unknown): number;
export declare function totalFromComponents(row: ModelTokenUsage): number;
export declare function withDerivedTotals(rows: ModelTokenUsage[]): ModelTokenUsage[];
