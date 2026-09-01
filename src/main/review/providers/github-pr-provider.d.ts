import { type ParsedPullRequest, type PullRequestProvider } from '../../../shared/review';
import { type ReviewSourceProvider } from '../changeset-service';
export interface FetchResponseLike {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
export type FetchLike = (url: string, init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
}) => Promise<FetchResponseLike>;
export interface GhResult {
    found: boolean;
    code: number;
    stdout: string;
    stderr: string;
}
export interface GhRunner {
    available(): Promise<boolean>;
    run(args: string[]): Promise<GhResult>;
}
export interface GithubPrProviderDeps {
    gh: GhRunner;
    fetchImpl: FetchLike;
    resolveToken: (host: string, provider: PullRequestProvider) => Promise<string | null>;
}
export declare function createGithubPrProvider(deps: GithubPrProviderDeps): ReviewSourceProvider;
export declare function createDefaultGhRunner(): GhRunner;
export declare function defaultResolveToken(host: string, provider: PullRequestProvider): Promise<string | null>;
export interface RemoteRepoRef {
    host: string;
    owner: string;
    repo: string;
}
export declare function parseGitRemoteRef(rawRemote: string): RemoteRepoRef | null;
export declare function remoteMatchesPullRequest(remote: RemoteRepoRef, pr: ParsedPullRequest): boolean;
export declare function readProjectRemoteUrls(root: string): Promise<string[]>;
export declare function matchPrProjectRoots(url: string, roots: readonly string[], readRemoteUrls?: (root: string) => Promise<string[]>): Promise<string[]>;
export declare const githubPrProvider: ReviewSourceProvider;
