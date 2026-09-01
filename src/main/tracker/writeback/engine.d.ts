import type { TrackerCapabilities, TrackerProviderId } from '../../../shared/tracker/types';
import { type TrackerWriteBackConfig, type TrackerWriteBackPostKind } from '../../../shared/tracker/writeback';
export type RunWriteBackFacts = {
    runId: string;
    goal: string;
    started: boolean;
    completed: boolean;
    canceled: boolean;
    pullRequestUrls: string[];
    taskCount: number;
};
export type RunStateReader = {
    readRunFacts(input: {
        statePath: string;
    }): Promise<RunWriteBackFacts | null>;
};
export type RunProxyItem = {
    relativePath: string;
    provider: TrackerProviderId;
    connectionId: string;
    externalId: string;
    nativeKey: string;
};
export type ProxyItemLookup = {
    proxyItemsForRun(input: {
        workspaceRoot: string;
        statePath: string;
    }): Promise<RunProxyItem[]>;
};
export type WriteBackCapabilityResolver = {
    capabilitiesFor(provider: TrackerProviderId): TrackerCapabilities | undefined;
};
export type TrackerWriteBackPoster = {
    postComment(input: {
        provider: TrackerProviderId;
        connectionId: string;
        externalId: string;
        body: string;
    }): Promise<void>;
    transitionIssue(input: {
        provider: TrackerProviderId;
        connectionId: string;
        externalId: string;
        transitionId: string;
    }): Promise<void>;
};
export type WriteBackConfigReader = {
    get(connectionId: string): Promise<TrackerWriteBackConfig>;
    anyActive(): Promise<boolean>;
};
export type WriteBackLedgerPort = {
    hasPosted(key: string): Promise<boolean>;
    markPosted(meta: LedgerWriteMeta): Promise<void>;
    recordFailure(meta: LedgerWriteMeta): Promise<void>;
};
type LedgerWriteMeta = {
    key: string;
    statePath: string;
    connectionId: string;
    externalId: string;
    provider: TrackerProviderId;
    postKind: TrackerWriteBackPostKind;
    relativePath: string;
    at: string;
    message?: string;
};
export type TrackerWriteBackEngineDeps = {
    runState: RunStateReader;
    proxyItems: ProxyItemLookup;
    config: WriteBackConfigReader;
    capabilities: WriteBackCapabilityResolver;
    poster: TrackerWriteBackPoster;
    ledger: WriteBackLedgerPort;
    now: () => Date;
    logDiagnostic?: (event: string, payload: Record<string, unknown>) => void;
};
export type ReconcileSummary = {
    posted: number;
    failed: number;
    skipped: number;
    reason?: 'no_active_config' | 'run_unreadable' | 'not_started' | 'no_proxy_items' | 'error';
};
type DesiredPost = {
    postKind: TrackerWriteBackPostKind;
    type: 'comment';
    body: string;
    keyDiscriminator?: string;
} | {
    postKind: TrackerWriteBackPostKind;
    type: 'transition';
    transitionId: string;
};
export declare class TrackerWriteBackEngine {
    private readonly deps;
    constructor(deps: TrackerWriteBackEngineDeps);
    reconcileRun(input: {
        statePath: string;
        workspaceRoot: string;
    }): Promise<ReconcileSummary>;
    private attempt;
}
export declare function desiredPostsFor(facts: RunWriteBackFacts, config: TrackerWriteBackConfig, capabilities: TrackerCapabilities | undefined): DesiredPost[];
export {};
