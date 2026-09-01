import { TrackerConnectionStore, type TrackerConnectionStoreOptions } from './connection-store';
import { TrackerProviderRegistry } from './provider-registry';
import { toTrackerError, type TrackerAddConnectionInput, type TrackerAddConnectionResult, type TrackerFetchIssueInput, type TrackerFetchIssueResult, type TrackerListConnectionsResult, type TrackerRemoveConnectionInput, type TrackerRemoveConnectionResult, type TrackerSearchInput, type TrackerSearchResult, type TrackerTestConnectionInput, type TrackerTestConnectionResult, type TrackerTransition } from '../../shared/tracker/types';
export type TrackerWriteBackCleanup = {
    removeConfig(connectionId: string): Promise<void>;
    dropLedger(connectionId: string): Promise<void>;
};
export declare class TrackerService {
    private readonly connectionStore;
    private readonly registry;
    private readonly writeBackCleanup;
    constructor(options?: {
        connectionStore?: TrackerConnectionStore;
        registry?: TrackerProviderRegistry;
        writeBackCleanup?: TrackerWriteBackCleanup;
    });
    get connections(): TrackerConnectionStore;
    listConnections(): Promise<TrackerListConnectionsResult>;
    addConnection(input: TrackerAddConnectionInput): Promise<TrackerAddConnectionResult>;
    removeConnection(input: TrackerRemoveConnectionInput): Promise<TrackerRemoveConnectionResult>;
    testConnection(input: TrackerTestConnectionInput): Promise<TrackerTestConnectionResult>;
    search(input: TrackerSearchInput): Promise<TrackerSearchResult>;
    fetchIssue(input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult>;
    listTransitions(input: {
        connectionId: string;
        externalId: string;
    }): Promise<{
        ok: true;
        transitions: TrackerTransition[];
    } | {
        ok: false;
        error: ReturnType<typeof toTrackerError>;
    }>;
    private probe;
    private withProvider;
}
export declare function getSharedTrackerService(overrides?: TrackerConnectionStoreOptions): TrackerService;
