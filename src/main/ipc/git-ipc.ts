import type { IpcMain } from 'electron'
import {
  checkoutGitCommit,
  checkoutGitCommitAsBranch,
  commitGitChanges,
  copyGitWorktreeIncludedFiles,
  createGitBranchFromCommit,
  createGitTagFromCommit,
  createGitWorktree,
  discardUnstagedGitChanges,
  fetchGitRemotes,
  getGitBranches,
  getGitCommitGraph,
  getGitConflictFile,
  getGitConflicts,
  getGitFileBase,
  getGitHistory,
  getGitRepoRoot,
  getGitStatus,
  listGitWorktrees,
  pullGitBranchWithStash,
  pruneGitWorktrees,
  removeGitWorktree,
  repairGitWorktrees,
  resolveGitConflict,
  pushGitBranch,
  revertGitPaths,
  stageGitPaths,
  switchGitBranch,
  unstageGitPaths,
} from '../git'

type IpcDiagnostics = {
  enabled: boolean
  logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void
  withIpcDiagnostics<T>(
    scope: string,
    event: string,
    payload: Record<string, unknown>,
    action: () => Promise<T>
  ): Promise<T>
}

export function registerGitIpc(ipcMain: IpcMain, diagnostics: IpcDiagnostics): void {
  ipcMain.handle('git:get-repo-root', async (_, folderPath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-repo-root', { folderPath }, () => getGitRepoRoot(folderPath))
  })

  ipcMain.handle('git:get-status', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-status', { repoRoot }, async () => {
      const snapshot = await getGitStatus(repoRoot)
      return snapshot
    }).then((snapshot) => {
      if (diagnostics.enabled) {
        diagnostics.logMainPerfEvent('GitIPC', 'get-status-result', {
          repoRoot,
          changedFileCount: Object.keys(snapshot.files).length,
        })
      }
      return snapshot
    })
  })

  ipcMain.handle('git:get-file-base', async (_, repoRoot: string, filePath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-file-base', { repoRoot, filePath }, () => getGitFileBase(repoRoot, filePath))
  })

  ipcMain.handle('git:get-branches', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-branches', { repoRoot }, () => getGitBranches(repoRoot))
  })

  ipcMain.handle('git:get-history', async (_, repoRoot: string, limit?: number) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-history', { repoRoot, limit }, () => getGitHistory(repoRoot, limit))
  })

  ipcMain.handle('git:get-commit-graph', async (_, repoRoot: string, options?: { limit?: number; skip?: number }) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-commit-graph', { repoRoot, ...options }, () =>
      getGitCommitGraph(repoRoot, options ?? {})
    )
  })

  ipcMain.handle('git:get-conflicts', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-conflicts', { repoRoot }, () => getGitConflicts(repoRoot))
  })

  ipcMain.handle('git:get-conflict-file', async (_, repoRoot: string, filePath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-conflict-file', { repoRoot, filePath }, () => getGitConflictFile(repoRoot, filePath))
  })

  ipcMain.handle('git:resolve-conflict', async (_, repoRoot: string, filePath: string, content: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'resolve-conflict', { repoRoot, filePath }, () => resolveGitConflict(repoRoot, filePath, content))
  })

  ipcMain.handle('git:stage', async (_, repoRoot: string, paths: string[]) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stage', { repoRoot, pathCount: paths.length }, () => stageGitPaths(repoRoot, paths))
  })

  ipcMain.handle('git:unstage', async (_, repoRoot: string, paths: string[]) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'unstage', { repoRoot, pathCount: paths.length }, () => unstageGitPaths(repoRoot, paths))
  })

  ipcMain.handle('git:revert', async (_, repoRoot: string, paths: string[]) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'revert', { repoRoot, pathCount: paths.length }, () => revertGitPaths(repoRoot, paths))
  })

  ipcMain.handle('git:discard-unstaged', async (_, repoRoot: string, paths: string[]) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'discard-unstaged', { repoRoot, pathCount: paths.length }, () => discardUnstagedGitChanges(repoRoot, paths))
  })

  ipcMain.handle('git:commit', async (_, repoRoot: string, message: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'commit', { repoRoot, messageLength: message.length }, () => commitGitChanges(repoRoot, message))
  })

  ipcMain.handle('git:push', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'push', { repoRoot }, () => pushGitBranch(repoRoot))
  })

  ipcMain.handle('git:fetch', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'fetch', { repoRoot }, () => fetchGitRemotes(repoRoot))
  })

  ipcMain.handle('git:pull-with-stash', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'pull-with-stash', { repoRoot }, () => pullGitBranchWithStash(repoRoot))
  })

  ipcMain.handle('git:switch-branch', async (_, repoRoot: string, branchName: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'switch-branch', { repoRoot, branchName }, () => switchGitBranch(repoRoot, branchName))
  })

  ipcMain.handle('git:checkout-commit', async (_, repoRoot: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'checkout-commit', { repoRoot, commitHash }, () => checkoutGitCommit(repoRoot, commitHash))
  })

  ipcMain.handle('git:branch-from-commit', async (_, repoRoot: string, branchName: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'branch-from-commit', { repoRoot, branchName, commitHash }, () =>
      createGitBranchFromCommit(repoRoot, branchName, commitHash)
    )
  })

  ipcMain.handle('git:checkout-commit-as-branch', async (_, repoRoot: string, branchName: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'checkout-commit-as-branch', { repoRoot, branchName, commitHash }, () =>
      checkoutGitCommitAsBranch(repoRoot, branchName, commitHash)
    )
  })

  ipcMain.handle('git:tag-from-commit', async (_, repoRoot: string, tagName: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'tag-from-commit', { repoRoot, tagName, commitHash }, () =>
      createGitTagFromCommit(repoRoot, tagName, commitHash)
    )
  })

  ipcMain.handle('git:worktree:list', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'worktree-list', { repoRoot }, () => listGitWorktrees(repoRoot))
  })

  ipcMain.handle('git:worktree:create', async (_, input) => {
    return createGitWorktree(input)
  })

  ipcMain.handle('git:worktree:remove', async (_, input) => {
    return removeGitWorktree(input)
  })

  ipcMain.handle('git:worktree:prune', async (_, repoRoot: string) => {
    return pruneGitWorktrees(repoRoot)
  })

  ipcMain.handle('git:worktree:repair', async (_, input) => {
    return repairGitWorktrees(input)
  })

  ipcMain.handle('git:worktree:copy-included', async (_, input) => {
    return copyGitWorktreeIncludedFiles(input)
  })
}
