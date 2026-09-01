import type { GitWorktreeEntry, GitWorktreeListSnapshot, GitWorktreeOperationResult } from './git';
export declare function parseGitWorktreePorcelain(output: string): GitWorktreeEntry[];
export declare function listGitWorktrees(repoRoot: string): Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>>;
