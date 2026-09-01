import type { GitHubTokenStore } from './github-token-store';
import type { GitHubRepoListResult } from '../shared/electron-api';
/**
 * The signed-in user's repositories for the new-workspace clone picker.
 * Never throws — the picker renders each failure reason differently (connect
 * hint vs. bad token vs. retry), so the reason travels in the result.
 */
export declare function listGitHubRepos(tokenStore: GitHubTokenStore): Promise<GitHubRepoListResult>;
export declare function nextGitHubPageUrl(linkHeader: string | null): string | null;
