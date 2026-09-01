import type { GitCommandResult, GitStashListSnapshot } from './git';
export declare function listGitStashes(repoRoot: string): Promise<GitStashListSnapshot>;
export declare function pushGitStash(repoRoot: string, message: string, includeUntracked?: boolean): Promise<GitCommandResult>;
export declare function applyGitStash(repoRoot: string, index: number, expectedHash: string, pop?: boolean): Promise<GitCommandResult>;
export declare function dropGitStash(repoRoot: string, index: number, expectedHash: string): Promise<GitCommandResult>;
