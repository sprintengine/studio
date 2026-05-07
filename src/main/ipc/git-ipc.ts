import type { IpcMain } from 'electron'
import {
  commitGitChanges,
  copyGitWorktreeIncludedFiles,
  createGitWorktree,
  discardUnstagedGitChanges,
  getGitBranches,
  getGitFileBase,
  getGitHistory,
  getGitRepoRoot,
  getGitStatus,
  listGitWorktrees,
  pruneGitWorktrees,
  removeGitWorktree,
  repairGitWorktrees,
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

  ipcMain.handle('git:switch-branch', async (_, repoRoot: string, branchName: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'switch-branch', { repoRoot, branchName }, () => switchGitBranch(repoRoot, branchName))
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
