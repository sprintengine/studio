import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  GitBranchSnapshot,
  GitCommandResult,
  GitConflictFileContent,
  GitConflictSnapshot,
  GitFileBaseResult,
  GitHistorySnapshot,
  GitStatusSnapshot,
  GitWorktreeCopyIncludedInput,
  GitWorktreeCopyIncludedResult,
  GitWorktreeCreateInput,
  GitWorktreeEntry,
  GitWorktreeListSnapshot,
  GitWorktreeOperationResult,
  GitWorktreeRemoveInput,
  GitWorktreeRepairInput,
  SymphonyGitHubSyncInput,
  SymphonyGitHubSyncResult,
} from '../../shared/electron-api'

export const gitApi = {
  getGitRepoRoot: (folderPath: string): Promise<string | null> =>
    ipcRenderer.invoke('git:get-repo-root', folderPath),
  getGitStatus: (repoRoot: string): Promise<GitStatusSnapshot> =>
    ipcRenderer.invoke('git:get-status', repoRoot),
  getGitFileBase: (repoRoot: string, filePath: string): Promise<GitFileBaseResult> =>
    ipcRenderer.invoke('git:get-file-base', repoRoot, filePath),
  getGitBranches: (repoRoot: string): Promise<GitBranchSnapshot> =>
    ipcRenderer.invoke('git:get-branches', repoRoot),
  getGitHistory: (repoRoot: string, limit?: number): Promise<GitHistorySnapshot> =>
    ipcRenderer.invoke('git:get-history', repoRoot, limit),
  getGitConflicts: (repoRoot: string): Promise<GitConflictSnapshot> =>
    ipcRenderer.invoke('git:get-conflicts', repoRoot),
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
  listGitWorktrees: (repoRoot: string): Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>> =>
    ipcRenderer.invoke('git:worktree:list', repoRoot),
  createGitWorktree: (input: GitWorktreeCreateInput): Promise<GitWorktreeOperationResult<GitWorktreeEntry>> =>
    ipcRenderer.invoke('git:worktree:create', input),
  removeGitWorktree: (input: GitWorktreeRemoveInput): Promise<GitWorktreeOperationResult<GitCommandResult>> =>
    ipcRenderer.invoke('git:worktree:remove', input),
  pruneGitWorktrees: (repoRoot: string): Promise<GitWorktreeOperationResult<GitCommandResult>> =>
    ipcRenderer.invoke('git:worktree:prune', repoRoot),
  repairGitWorktrees: (input: GitWorktreeRepairInput): Promise<GitWorktreeOperationResult<GitCommandResult>> =>
    ipcRenderer.invoke('git:worktree:repair', input),
  copyGitWorktreeIncludedFiles: (
    input: GitWorktreeCopyIncludedInput
  ): Promise<GitWorktreeOperationResult<GitWorktreeCopyIncludedResult>> =>
    ipcRenderer.invoke('git:worktree:copy-included', input),
  syncSymphonyGitHubIssues: (input: SymphonyGitHubSyncInput): Promise<SymphonyGitHubSyncResult> =>
    ipcRenderer.invoke('symphony:github:sync-issues', input),
} satisfies Pick<
  ElectronApi,
  | 'getGitRepoRoot'
  | 'getGitStatus'
  | 'getGitFileBase'
  | 'getGitBranches'
  | 'getGitHistory'
  | 'getGitConflicts'
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
  | 'listGitWorktrees'
  | 'createGitWorktree'
  | 'removeGitWorktree'
  | 'pruneGitWorktrees'
  | 'repairGitWorktrees'
  | 'copyGitWorktreeIncludedFiles'
  | 'syncSymphonyGitHubIssues'
>
