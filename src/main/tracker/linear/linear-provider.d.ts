import type { ProviderSecretValueResult } from '../../secret-store';
import { type NormalizedIssue, type TrackerCapabilities, type TrackerConnection, type TrackerConnectionProbe, type TrackerProvider } from '../../../shared/tracker/types';
import { type LinearFetch } from './linear-client';
export declare const LINEAR_CAPABILITIES: TrackerCapabilities;
export type LinearConnectionAccess = {
    getConnection(id: string): Promise<TrackerConnection | undefined>;
    resolveSecret(id: string): Promise<ProviderSecretValueResult>;
};
export type LinearTrackerProviderOptions = {
    connections: LinearConnectionAccess;
    endpoint?: string;
    fetchImpl?: LinearFetch;
    timeoutMs?: number;
};
export declare class LinearTrackerProvider implements TrackerProvider {
    readonly provider: "linear";
    readonly capabilities: TrackerCapabilities;
    private readonly connections;
    private readonly endpoint;
    private readonly fetchImpl;
    private readonly timeoutMs;
    constructor(options: LinearTrackerProviderOptions);
    searchIssues(args: {
        connectionId: string;
        query: string;
        cursor?: string;
    }): Promise<{
        issues: NormalizedIssue[];
        nextCursor?: string;
    }>;
    fetchIssue(args: {
        connectionId: string;
        externalId: string;
    }): Promise<NormalizedIssue>;
    listAssignedToMe(args: {
        connectionId: string;
    }): Promise<NormalizedIssue[]>;
    postComment(args: {
        connectionId: string;
        externalId: string;
        body: string;
    }): Promise<void>;
    transitionIssue(args: {
        connectionId: string;
        externalId: string;
        transitionId: string;
    }): Promise<void>;
    testConnection(args: {
        connectionId: string;
    }): Promise<TrackerConnectionProbe>;
    private request;
    private resolveApiKey;
    private unsupported;
}
