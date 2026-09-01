import type { SkillTreeEntry } from './scan';
export type SkillFetch = (url: string, init: RequestInit) => Promise<Response>;
export declare const DEFAULT_SKILL_FETCH_TIMEOUT_MS = 30000;
export declare const DEFAULT_SKILL_MAX_FILE_BYTES: number;
export declare const DEFAULT_SKILL_MAX_LISTING_BYTES: number;
export declare const DEFAULT_SKILL_MAX_TREE_ENTRIES = 200000;
export type SkillRepoRef = {
    owner: string;
    repo: string;
    ref: string;
};
export type SkillRepoTree = {
    commitSha: string;
    entries: SkillTreeEntry[];
};
export type SkillGithubOptions = {
    fetcher?: SkillFetch;
    timeoutMs?: number;
    maxFileBytes?: number;
    /** Resolved GitHub token; '' fetches unauthenticated. */
    token?: string;
};
/**
 * Accept what a user actually has in their clipboard: `owner/repo`, a repo URL,
 * a `/tree/<ref>` deep link, or a `.git` clone URL. Anything else is refused
 * rather than guessed at.
 */
export declare function parseSkillRepoRef(input: string): SkillRepoRef | null;
export declare class SkillFetchError extends Error {
    readonly statusCode?: number | undefined;
    constructor(message: string, statusCode?: number | undefined);
}
/** Resolve a ref (or the default branch) to the commit SHA the scan pins to. */
export declare function resolveSkillRepoCommit(ref: SkillRepoRef, options?: SkillGithubOptions): Promise<string>;
/**
 * The whole repository listing in one call. A tree GitHub reports as truncated
 * fails rather than scanning a partial repository — a source silently missing
 * half its skills is worse than a source that says it could not be read.
 */
export declare function fetchSkillRepoTree(ref: SkillRepoRef, commitSha: string, options?: SkillGithubOptions): Promise<SkillRepoTree>;
/** Read one file's bytes at the scanned commit. */
export declare function fetchSkillRepoFile(ref: SkillRepoRef, commitSha: string, path: string, options?: SkillGithubOptions): Promise<Buffer>;
