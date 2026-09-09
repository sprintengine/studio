import { ipcRenderer } from 'electron'
import type { RepositoryIdentityRead } from '../../shared/repository-identity'
import type {
  ElectronApi,
  GitHubCloneInput,
  GitHubCloneResult,
  GitHubRepoListResult,
  GitHubTokenStatus,
  GitBranchSnapshot,
  GitCommandResult,
  GitConflictFileContent,
  GitFileBaseResult,
  GitFileStage,
  GitFileStageResult,
  GitGraphOptions,
  GitGraphSnapshot,
  GitRepoOperation,
  GitResetMode,
  GitStashListSnapshot,
  GitRowSummary,
  BranchStepDiff,
  BranchStepSelection,
  BranchStepsSnapshot,
  RevFileResult,
  WorkspaceChangeSummary,
  GitStatusSnapshot,
  GitWorktreeCreateInput,
  GitWorktreeEntry,
  GitWorktreeListSnapshot,
  GitWorktreeOperationResult,
  GitWorktreeRemoveInput,
} from '../../shared/electron-api'

export const gitApi = {
  getGitRepoRoot: (folderPath: string): Promise<string | null> =>
    ipcRenderer.invoke('git:get-repo-root', folderPath),
  getGitStatus: (repoRoot: string): Promise<GitStatusSnapshot> =>
    ipcRenderer.invoke('git:get-status', repoRoot),
  checkIgnored: (repoRoot: string, relativePaths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('git:check-ignored', repoRoot, relativePaths),
  getGitRowSummary: (repoRoot: string): Promise<GitRowSummary> =>
    ipcRenderer.invoke('git:get-row-summary', repoRoot),
  getWorkspaceChangeSummary: (checkoutPath: string): Promise<WorkspaceChangeSummary> =>
    ipcRenderer.invoke('git:get-workspace-change-summary', checkoutPath),
  getBranchSteps: (checkoutPath: string): Promise<BranchStepsSnapshot> =>
    ipcRenderer.invoke('git:get-branch-steps', checkoutPath),
  getBranchStepDiff: (
    checkoutPath: string,
    selection: BranchStepSelection
  ): Promise<BranchStepDiff> =>
    ipcRenderer.invoke('git:get-branch-step-diff', checkoutPath, selection),
  getGitFileAtRev: (repoRoot: string, rev: string, filePath: string): Promise<RevFileResult> =>
    ipcRenderer.invoke('git:get-file-at-rev', repoRoot, rev, filePath),
  getGitFileBase: (repoRoot: string, filePath: string): Promise<GitFileBaseResult> =>
    ipcRenderer.invoke('git:get-file-base', repoRoot, filePath),
  getGitFileAtStage: (repoRoot: string, filePath: string, stage: GitFileStage): Promise<GitFileStageResult> =>
    ipcRenderer.invoke('git:get-file-at-stage', repoRoot, filePath, stage),
  getGitBranches: (repoRoot: string): Promise<GitBranchSnapshot> =>
    ipcRenderer.invoke('git:get-branches', repoRoot),
  getGitRepositoryIdentity: (folderPath: string): Promise<RepositoryIdentityRead> =>
    ipcRenderer.invoke('git:get-repository-identity', folderPath),
  getGitCommitGraph: (repoRoot: string, options?: GitGraphOptions): Promise<GitGraphSnapshot> =>
    ipcRenderer.invoke('git:get-commit-graph', repoRoot, options),
  getGitConflictFile: (repoRoot: string, filePath: string): Promise<GitConflictFileContent | null> =>
    ipcRenderer.invoke('git:get-conflict-file', repoRoot, filePath),
  resolveGitConflict: (repoRoot: string, filePath: string, content: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:resolve-conflict', repoRoot, filePath, content),
  stageGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stage', repoRoot, paths),
  unstageGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:unstage', repoRoot, paths),
  revertGitPaths: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:revert', repoRoot, paths),
  discardUnstagedGitChanges: (repoRoot: string, paths: string[]): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:discard-unstaged', repoRoot, paths),
  commitGitChanges: (repoRoot: string, message: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:commit', repoRoot, message),
  pushGitBranch: (repoRoot: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:push', repoRoot),
  fetchGitRemotes: (repoRoot: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:fetch', repoRoot),
  pullGitBranchWithStash: (repoRoot: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:pull-with-stash', repoRoot),
  switchGitBranch: (repoRoot: string, branchName: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:switch-branch', repoRoot, branchName),
  mergeGitRef: (repoRoot: string, ref: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:merge-ref', repoRoot, ref),
  rebaseGitBranch: (repoRoot: string, ontoRef: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:rebase-branch', repoRoot, ontoRef),
  cherryPickGitCommit: (repoRoot: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:cherry-pick', repoRoot, commitHash),
  revertGitCommit: (repoRoot: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:revert-commit', repoRoot, commitHash),
  resetGitBranchToCommit: (repoRoot: string, commitHash: string, mode: GitResetMode): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:reset-to-commit', repoRoot, commitHash, mode),
  deleteGitBranch: (repoRoot: string, branchName: string, force?: boolean): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:delete-branch', repoRoot, branchName, force),
  renameGitBranch: (repoRoot: string, branchName: string, newName: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:rename-branch', repoRoot, branchName, newName),
  continueGitOperation: (repoRoot: string, operation: GitRepoOperation): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:operation-continue', repoRoot, operation),
  abortGitOperation: (repoRoot: string, operation: GitRepoOperation): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:operation-abort', repoRoot, operation),
  listGitStashes: (repoRoot: string): Promise<GitStashListSnapshot> =>
    ipcRenderer.invoke('git:stash-list', repoRoot),
  pushGitStash: (repoRoot: string, message: string, includeUntracked?: boolean): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stash-push', repoRoot, message, includeUntracked),
  applyGitStash: (repoRoot: string, index: number, expectedHash: string, pop?: boolean): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stash-apply', repoRoot, index, expectedHash, pop),
  dropGitStash: (repoRoot: string, index: number, expectedHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:stash-drop', repoRoot, index, expectedHash),
  checkoutGitCommit: (repoRoot: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:checkout-commit', repoRoot, commitHash),
  checkoutGitCommitAsBranch: (repoRoot: string, branchName: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:checkout-commit-as-branch', repoRoot, branchName, commitHash),
  createGitTagFromCommit: (repoRoot: string, tagName: string, commitHash: string): Promise<GitCommandResult> =>
    ipcRenderer.invoke('git:tag-from-commit', repoRoot, tagName, commitHash),
  listGitWorktrees: (repoRoot: string): Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>> =>
    ipcRenderer.invoke('git:worktree:list', repoRoot),
  createGitWorktree: (input: GitWorktreeCreateInput): Promise<GitWorktreeOperationResult<GitWorktreeEntry>> =>
    ipcRenderer.invoke('git:worktree:create', input),
  removeGitWorktree: (input: GitWorktreeRemoveInput): Promise<GitWorktreeOperationResult<GitCommandResult>> =>
    ipcRenderer.invoke('git:worktree:remove', input),
  pruneGitWorktrees: (repoRoot: string): Promise<GitWorktreeOperationResult<GitCommandResult>> =>
    ipcRenderer.invoke('git:worktree:prune', repoRoot),
  getGitHubTokenStatus: (): Promise<GitHubTokenStatus> =>
    ipcRenderer.invoke('github:token-status'),
  setGitHubToken: (token: string): Promise<GitHubTokenStatus> =>
    ipcRenderer.invoke('github:set-token', token),
  clearGitHubToken: (): Promise<GitHubTokenStatus> =>
    ipcRenderer.invoke('github:clear-token'),
  listGitHubRepos: (): Promise<GitHubRepoListResult> =>
    ipcRenderer.invoke('github:list-repos'),
  cloneGitHubRepo: (input: GitHubCloneInput): Promise<GitHubCloneResult> =>
    ipcRenderer.invoke('github:clone', input),
} satisfies Pick<
  ElectronApi,
  | 'getGitRepoRoot'
  | 'getGitStatus'
  | 'checkIgnored'
  | 'getGitRowSummary'
  | 'getWorkspaceChangeSummary'
  | 'getBranchSteps'
  | 'getBranchStepDiff'
  | 'getGitFileAtRev'
  | 'getGitFileBase'
  | 'getGitFileAtStage'
  | 'getGitBranches'
  | 'getGitRepositoryIdentity'
  | 'getGitCommitGraph'
  | 'getGitConflictFile'
  | 'resolveGitConflict'
  | 'stageGitPaths'
  | 'unstageGitPaths'
  | 'revertGitPaths'
  | 'discardUnstagedGitChanges'
  | 'commitGitChanges'
  | 'pushGitBranch'
  | 'fetchGitRemotes'
  | 'pullGitBranchWithStash'
  | 'switchGitBranch'
  | 'mergeGitRef'
  | 'rebaseGitBranch'
  | 'cherryPickGitCommit'
  | 'revertGitCommit'
  | 'resetGitBranchToCommit'
  | 'deleteGitBranch'
  | 'renameGitBranch'
  | 'continueGitOperation'
  | 'abortGitOperation'
  | 'listGitStashes'
  | 'pushGitStash'
  | 'applyGitStash'
  | 'dropGitStash'
  | 'checkoutGitCommit'
  | 'checkoutGitCommitAsBranch'
  | 'createGitTagFromCommit'
  | 'listGitWorktrees'
  | 'createGitWorktree'
  | 'removeGitWorktree'
  | 'pruneGitWorktrees'
  | 'getGitHubTokenStatus'
  | 'setGitHubToken'
  | 'clearGitHubToken'
  | 'listGitHubRepos'
  | 'cloneGitHubRepo'
>
