import { type GitHubRepoRef } from './git-github';
import type { GitHubTokenStore } from './github-token-store';
import type { SwitchboardImportItem, SwitchboardImportResult } from '../shared/switchboard';
type GitHubIssueApiRecord = {
    id?: unknown;
    node_id?: unknown;
    number?: unknown;
    title?: unknown;
    body?: unknown;
    html_url?: unknown;
    updated_at?: unknown;
    labels?: unknown;
    pull_request?: unknown;
};
export declare function importGitHubIssuesIntoWatchtower(input: {
    workspaceRoot: string;
    tokenStore: GitHubTokenStore;
}): Promise<SwitchboardImportResult>;
export declare function githubIssueToImportItem(repo: GitHubRepoRef, issue: GitHubIssueApiRecord): SwitchboardImportItem;
export declare function nextGitHubPageUrl(linkHeader: string | null): string | null;
export {};
