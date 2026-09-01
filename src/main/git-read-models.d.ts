import type { GitBranchSnapshot, GitGraphOptions, GitGraphSnapshot, GitHistorySnapshot } from './git';
export declare function getGitBranches(repoRoot: string): Promise<GitBranchSnapshot>;
export declare function getGitHistory(repoRoot: string, limit?: number): Promise<GitHistorySnapshot>;
/**
 * Reads commit history across branches, remotes, and tags (plus HEAD, so a
 * detached checkout still appears) with parent hashes so the renderer can lay
 * out a branch graph. We deliberately do not use `--all`: that also walks
 * refs/stash and refs/notes, which would surface stash WIP commits in the graph
 * with no ref label. `--date-order` keeps commits in commit date order while
 * guaranteeing no parent is emitted before its children, which the lane-layout
 * algorithm relies on. Paginated via skip/limit so a large history stays bounded.
 */
export declare function getGitCommitGraph(repoRoot: string, options?: GitGraphOptions): Promise<GitGraphSnapshot>;
