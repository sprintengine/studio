import type { GitCommandResult } from './git';
export declare function stageGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult>;
export declare function unstageGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult>;
export declare function revertGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult>;
export declare function discardUnstagedGitChanges(repoRoot: string, paths: string[]): Promise<GitCommandResult>;
