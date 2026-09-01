export type GitHubRepoRef = {
    owner: string;
    repo: string;
    webUrl: string;
};
export declare function getGitHubRepoWebUrl(repoRoot: string): Promise<string | null>;
export declare function getGitHubRepoRef(repoRoot: string): Promise<GitHubRepoRef | null>;
export declare function githubRepoFromRemote(remoteUrl: string): GitHubRepoRef | null;
