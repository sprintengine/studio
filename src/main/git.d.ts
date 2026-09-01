export { listGitWorktrees, parseGitWorktreePorcelain } from './git-worktree-list';
export { getGitOperationInProgress, getGitStatus } from './git-status';
export { getGitBranches, getGitHistory, getGitCommitGraph } from './git-read-models';
export { applyGitStash, dropGitStash, listGitStashes, pushGitStash } from './git-stash';
export { discardUnstagedGitChanges, revertGitPaths, stageGitPaths, unstageGitPaths, } from './git-file-actions';
export { abortGitOperation, checkoutGitCommit, checkoutGitCommitAsBranch, cherryPickGitCommit, commitGitChanges, continueGitOperation, createGitBranchFromCommit, createGitTagFromCommit, deleteGitBranch, fetchGitRemotes, mergeGitRef, pullGitBranchWithStash, pushGitBranch, rebaseGitBranch, renameGitBranch, resetGitBranchToCommit, revertGitCommit, switchGitBranch, } from './git-branch-actions';
export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted';
export type GitStatusEntry = {
    path: string;
    relativePath: string;
    status: GitFileStatus;
    staged: boolean;
    unstaged: boolean;
};
/** A multi-step operation parked in the repo, awaiting continue or abort. */
export type GitRepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';
export type GitResetMode = 'soft' | 'mixed' | 'hard';
export type GitStatusSnapshot = {
    repoRoot: string;
    files: Record<string, GitStatusEntry>;
    operation: GitRepoOperation | null;
    updatedAt: number;
};
export type GitStashEntry = {
    /** Git's selector for the entry, e.g. `stash@{0}`. */
    ref: string;
    /** The stash commit hash — the entry's stable identity; selectors renumber. */
    hash: string;
    index: number;
    branch: string | null;
    message: string;
    createdAt: number;
};
export type GitStashListSnapshot = {
    repoRoot: string;
    stashes: GitStashEntry[];
    updatedAt: number;
};
export type GitFileBaseResult = {
    ok: true;
    content: string;
} | {
    ok: false;
    message: string;
};
export type GitFileStage = 'head' | 'index';
export type GitFileStageResult = {
    ok: true;
    exists: boolean;
    content: string;
    binary: boolean;
    tooLarge: boolean;
} | {
    ok: false;
    message: string;
};
export type GitBranch = {
    name: string;
    current: boolean;
    upstream: string | null;
};
export type GitBranchSnapshot = {
    current: string | null;
    branches: GitBranch[];
    ahead: number;
    behind: number;
};
export type GitCommit = {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    refs: string[];
    subject: string;
    commitWebUrl: string | null;
};
export type GitHistorySnapshot = {
    commits: GitCommit[];
    refs: GitRef[];
    totalCount: number;
    updatedAt: number;
};
export type GitGraphCommit = GitCommit & {
    parents: string[];
};
export type GitGraphSnapshot = {
    commits: GitGraphCommit[];
    refs: GitRef[];
    headHash: string | null;
    detached: boolean;
    totalCount: number;
    hasMore: boolean;
    updatedAt: number;
};
export type GitGraphOptions = {
    limit?: number;
    skip?: number;
};
export type GitRef = {
    name: string;
    hash: string;
    type: 'head' | 'remote' | 'tag' | 'other';
};
export type GitCommandResult = {
    ok: boolean;
    stdout: string;
    stderr: string;
    message: string | null;
    pushedCommitCount?: number;
};
export type GitWorktreeEntry = {
    path: string;
    head: string | null;
    branch: string | null;
    branchRef: string | null;
    detached: boolean;
    bare: boolean;
    locked: boolean;
    lockedReason: string | null;
    prunable: boolean;
    prunableReason: string | null;
};
export type GitWorktreeListSnapshot = {
    repoRoot: string;
    worktrees: GitWorktreeEntry[];
    updatedAt: number;
};
export type GitWorktreeCopyIncludedResult = {
    copied: string[];
    skipped: {
        path: string;
        reason: string;
    }[];
};
export type GitWorktreeOperationResult<T> = {
    ok: true;
    data: T;
    message: string | null;
    stdout?: string;
    stderr?: string;
} | {
    ok: false;
    message: string;
    stdout?: string;
    stderr?: string;
};
export type GitWorktreeCreateInput = {
    repoRoot: string;
    containerPath: string;
    destinationPath: string;
    branchName: string;
    baseRef: string;
    copyIncludedFiles?: boolean;
};
export type GitWorktreeRemoveInput = {
    repoRoot: string;
    path: string;
    force?: boolean;
};
export type GitWorktreeRepairInput = {
    repoRoot: string;
    path?: string;
};
export type GitWorktreeCopyIncludedInput = {
    repoRoot: string;
    worktreePath: string;
};
export type GitConflictFile = {
    path: string;
    relativePath: string;
    status: string;
};
export type GitConflictSnapshot = {
    repoRoot: string;
    files: GitConflictFile[];
    updatedAt: number;
};
export type GitConflictFileContent = {
    path: string;
    relativePath: string;
    base: string | null;
    ours: string | null;
    theirs: string | null;
    result: string;
};
export declare function getGitRepoRoot(folderPath: string): Promise<string | null>;
export declare function copyGitWorktreeIncludedFiles(input: GitWorktreeCopyIncludedInput): Promise<GitWorktreeOperationResult<GitWorktreeCopyIncludedResult>>;
export declare function createGitWorktree(input: GitWorktreeCreateInput): Promise<GitWorktreeOperationResult<GitWorktreeEntry>>;
export declare function removeGitWorktree(input: GitWorktreeRemoveInput): Promise<GitWorktreeOperationResult<GitCommandResult>>;
export declare function pruneGitWorktrees(repoRoot: string): Promise<GitWorktreeOperationResult<GitCommandResult>>;
export declare function repairGitWorktrees(input: GitWorktreeRepairInput): Promise<GitWorktreeOperationResult<GitCommandResult>>;
export declare function getGitFileBase(repoRoot: string, filePath: string): Promise<GitFileBaseResult>;
export declare function getGitFileAtStage(repoRoot: string, filePath: string, stage: GitFileStage): Promise<GitFileStageResult>;
export declare function getGitConflicts(repoRoot: string): Promise<GitConflictSnapshot>;
export declare function getGitConflictFile(repoRoot: string, filePath: string): Promise<GitConflictFileContent | null>;
export declare function resolveGitConflict(repoRoot: string, filePath: string, content: string): Promise<GitCommandResult>;
export declare const MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES: readonly [".mcp.json", ".codex/config.toml"];
/**
 * Append each of {@link entries} to a worktree's git exclude file so those paths
 * are never staged. The exclude path is resolved via
 * `git rev-parse --git-path info/exclude` — for a linked worktree git reads the
 * shared common-dir exclude, not a per-worktree one, so resolving it is the only
 * reliable way to land the entries where git will honor them. Idempotent per
 * entry: an already-present line is not duplicated. Throws if git or the write
 * fails.
 */
export declare function appendWorktreeGitExcludes(worktreePath: string, entries: readonly string[]): Promise<void>;
/**
 * Keep the generated managed MCP config ({@link MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES})
 * out of a connector worktree's git. Best-effort at the call site: the caller
 * swallows failures so a launch is never blocked by an exclude write.
 */
export declare function excludeMcpConfigFromWorktree(worktreePath: string): Promise<void>;
