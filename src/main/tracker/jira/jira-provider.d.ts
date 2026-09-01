import type { ProviderSecretValueResult } from '../../secret-store';
import { type NormalizedIssue, type TrackerCapabilities, type TrackerConnection, type TrackerConnectionProbe, type TrackerProvider, type TrackerTransition } from '../../../shared/tracker/types';
export type JiraConnectionAccess = {
    getConnection(id: string): Promise<TrackerConnection | undefined>;
    resolveSecret(id: string): Promise<ProviderSecretValueResult>;
};
export type JiraProviderDeps = {
    connections: JiraConnectionAccess;
    fetchImpl?: typeof fetch;
};
export declare class JiraTrackerProvider implements TrackerProvider {
    readonly provider: "jira";
    readonly capabilities: TrackerCapabilities;
    private readonly connections;
    private readonly fetchImpl;
    constructor(deps: JiraProviderDeps);
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
    listTransitions(args: {
        connectionId: string;
        externalId: string;
    }): Promise<TrackerTransition[]>;
    testConnection(args: {
        connectionId: string;
    }): Promise<TrackerConnectionProbe>;
    private searchPageDataCenter;
    private searchPageCloud;
    private resolve;
}
export declare function markdownToJiraWiki(markdown: string): string;
