import type { GitCommandResult, GitWorktreeOperationResult } from './git';
export declare function resolveRepoRoot(repoRoot: string): Promise<GitWorktreeOperationResult<string>>;
export declare function resolveWorktreeDestination(containerPath: string, destinationPath: string): GitWorktreeOperationResult<{
    containerPath: string;
    destinationPath: string;
}>;
export declare function validateBranchName(repoRoot: string, branchName: string): Promise<GitWorktreeOperationResult<string>>;
export declare function validateBaseRef(repoRoot: string, baseRef: string): Promise<GitWorktreeOperationResult<string>>;
export declare function toWorktreeResult<T>(result: GitCommandResult, data: T, successMessage?: string | null): GitWorktreeOperationResult<T>;
