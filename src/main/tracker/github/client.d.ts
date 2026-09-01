import { type NormalizedIssue, type TrackerCapabilities, type TrackerConnection, type TrackerConnectionProbe, type TrackerProvider } from '../../../shared/tracker/types';
import type { ProviderSecretValueResult } from '../../secret-store';
export type TrackerConnectionAccess = {
    getConnection(id: string): Promise<TrackerConnection | undefined>;
    resolveSecret(id: string): Promise<ProviderSecretValueResult>;
};
export type GitHubTrackerProviderOptions = {
    connections: TrackerConnectionAccess;
    fetchImpl?: typeof fetch;
};
export declare const GITHUB_CAPABILITIES: TrackerCapabilities;
export declare class GitHubTrackerProvider implements TrackerProvider {
    readonly provider: "github";
    readonly capabilities: TrackerCapabilities;
    private readonly connections;
    private readonly fetchImpl;
    constructor(options: GitHubTrackerProviderOptions);
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
    transitionIssue(): Promise<void>;
    testConnection(args: {
        connectionId: string;
    }): Promise<TrackerConnectionProbe>;
    private resolve;
    private fetchComments;
    private githubFetch;
    private normalizeIssue;
}
export declare function nextGitHubPageUrl(linkHeader: string | null): string | null;
