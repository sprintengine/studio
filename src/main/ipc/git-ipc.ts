import type { IpcMain } from 'electron'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { diffBranchSelection, listBranchSteps, readFileAtRev } from '../branch-steps'
import { getWorkspaceChangeSummary } from '../workspace-change-summary'
import { readRepositoryIdentity } from '../repository-identity'
import type { GitFileStage, GitRepoOperation, GitResetMode } from '../git'
import type { BranchStepSelection } from '../../shared/electron-api'
import { checkIgnoredPaths } from '../git-ignore'
import { readFileHunks, stageGitHunk, unstageGitHunk } from '../git-hunks'
import type { GitHunkRef, GitHunkScope } from '../../shared/git/hunks'
// Changelists and patches (git-commit-window T6).
import {
  createGitChangelist,
  deleteGitChangelist,
  getGitChangelists,
  moveGitChangelistPaths,
  renameGitChangelist,
  setActiveGitChangelist,
} from '../git-changelists'
import { createGitPatch, suggestedPatchFileName } from '../git-patch'
import {
  abortGitOperation,
  applyGitStash,
  checkoutGitCommit,
  checkoutGitCommitAsBranch,
  cherryPickGitCommit,
  commitGitChanges,
  continueGitOperation,
  deleteGitBranch,
  dropGitStash,
  listGitStashes,
  pushGitStash,
  rebaseGitBranch,
  renameGitBranch,
  resetGitBranchToCommit,
  revertGitCommit,
  createGitTagFromCommit,
  createGitWorktree,
  discardUnstagedGitChanges,
  fetchGitRemotes,
  getGitBranches,
  getGitCommitGraph,
  getGitConflictFile,
  getGitFileAtStage,
  getGitFileBase,
  getGitRepoRoot,
  getGitRowSummary,
  getGitStatus,
  listGitWorktrees,
  mergeGitRef,
  pullGitBranchWithStash,
  pruneGitWorktrees,
  removeGitWorktree,
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

/** Where the changelist store writes. Handed in rather than resolved here so
 *  this module stays free of `electron.app` and the store stays testable. */
export type GitIpcPaths = { userDataDir: string }

export function registerGitIpc(
  ipcMain: IpcMain,
  diagnostics: IpcDiagnostics,
  paths: GitIpcPaths = { userDataDir: '' }
): void {
  ipcMain.handle('git:get-repo-root', async (_, folderPath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-repo-root', { folderPath }, () => getGitRepoRoot(folderPath))
  })

  ipcMain.handle('git:get-row-summary', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-row-summary', { repoRoot }, () =>
      getGitRowSummary(repoRoot)
    )
  })

  ipcMain.handle('git:get-workspace-change-summary', async (_, checkoutPath: string) => {
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'get-workspace-change-summary',
      { checkoutPath },
      () => getWorkspaceChangeSummary({ checkoutPath })
    )
  })

  ipcMain.handle('git:get-branch-steps', async (_, checkoutPath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-branch-steps', { checkoutPath }, () =>
      listBranchSteps(checkoutPath)
    )
  })

  ipcMain.handle(
    'git:get-branch-step-diff',
    async (_, checkoutPath: string, selection: BranchStepSelection) => {
      return diagnostics.withIpcDiagnostics(
        'GitIPC',
        'get-branch-step-diff',
        { checkoutPath, selection: selection?.kind },
        () => diffBranchSelection(checkoutPath, selection)
      )
    }
  )

  ipcMain.handle('git:get-file-at-rev', async (_, repoRoot: string, rev: string, filePath: string) => {
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'get-file-at-rev',
      { repoRoot, rev, filePath },
      () => readFileAtRev(repoRoot, rev, filePath)
    )
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

  ipcMain.handle('git:check-ignored', async (_, repoRoot: string, relativePaths: string[]) => {
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'check-ignored',
      { repoRoot, pathCount: relativePaths.length },
      async () => Array.from(await checkIgnoredPaths(repoRoot, relativePaths))
    )
  })

  ipcMain.handle('git:get-file-base', async (_, repoRoot: string, filePath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-file-base', { repoRoot, filePath }, () => getGitFileBase(repoRoot, filePath))
  })

  ipcMain.handle('git:get-file-at-stage', async (_, repoRoot: string, filePath: string, stage: GitFileStage) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-file-at-stage', { repoRoot, filePath, stage }, () =>
      getGitFileAtStage(repoRoot, filePath, stage)
    )
  })

  // one-project-across-machines: which repository a folder is a clone of, for
  // the sidebar's grouping and the launch panel's machine filter.
  ipcMain.handle('git:get-repository-identity', async (_, folderPath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-repository-identity', { folderPath }, () =>
      readRepositoryIdentity(folderPath)
    )
  })

  ipcMain.handle('git:get-branches', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-branches', { repoRoot }, () => getGitBranches(repoRoot))
  })

  ipcMain.handle('git:get-commit-graph', async (_, repoRoot: string, options?: { limit?: number; skip?: number }) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-commit-graph', { repoRoot, ...options }, () =>
      getGitCommitGraph(repoRoot, options ?? {})
    )
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

  // Per-hunk staging (git-commit-window T7). The renderer NAMES a hunk — the
  // scope it was read in, its position as a hint and a fingerprint of its body
  // — and never sends a patch: main reads the diff again and writes the patch
  // itself, so nothing that crossed this boundary reaches `git apply`.
  ipcMain.handle('git:get-file-hunks', async (_, repoRoot: string, filePath: string, scope: GitHunkScope) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-file-hunks', { repoRoot, filePath, scope }, () =>
      readFileHunks(repoRoot, filePath, scope)
    )
  })

  ipcMain.handle('git:stage-hunk', async (_, ref: GitHunkRef) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stage-hunk', { repoRoot: ref.repoRoot, filePath: ref.filePath, index: ref.index }, () =>
      stageGitHunk(ref)
    )
  })

  ipcMain.handle('git:unstage-hunk', async (_, ref: GitHunkRef) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'unstage-hunk', { repoRoot: ref.repoRoot, filePath: ref.filePath, index: ref.index }, () =>
      unstageGitHunk(ref)
    )
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

  ipcMain.handle('git:merge-ref', async (_, repoRoot: string, ref: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'merge-ref', { repoRoot, ref }, () => mergeGitRef(repoRoot, ref))
  })

  ipcMain.handle('git:rebase-branch', async (_, repoRoot: string, ontoRef: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'rebase-branch', { repoRoot, ontoRef }, () => rebaseGitBranch(repoRoot, ontoRef))
  })

  ipcMain.handle('git:cherry-pick', async (_, repoRoot: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'cherry-pick', { repoRoot, commitHash }, () => cherryPickGitCommit(repoRoot, commitHash))
  })

  ipcMain.handle('git:revert-commit', async (_, repoRoot: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'revert-commit', { repoRoot, commitHash }, () => revertGitCommit(repoRoot, commitHash))
  })

  ipcMain.handle('git:reset-to-commit', async (_, repoRoot: string, commitHash: string, mode: GitResetMode) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'reset-to-commit', { repoRoot, commitHash, mode }, () =>
      resetGitBranchToCommit(repoRoot, commitHash, mode)
    )
  })

  ipcMain.handle('git:delete-branch', async (_, repoRoot: string, branchName: string, force?: boolean) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'delete-branch', { repoRoot, branchName, force }, () =>
      deleteGitBranch(repoRoot, branchName, force)
    )
  })

  ipcMain.handle('git:rename-branch', async (_, repoRoot: string, branchName: string, newName: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'rename-branch', { repoRoot, branchName, newName }, () =>
      renameGitBranch(repoRoot, branchName, newName)
    )
  })

  ipcMain.handle('git:operation-continue', async (_, repoRoot: string, operation: GitRepoOperation) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'operation-continue', { repoRoot, operation }, () =>
      continueGitOperation(repoRoot, operation)
    )
  })

  ipcMain.handle('git:operation-abort', async (_, repoRoot: string, operation: GitRepoOperation) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'operation-abort', { repoRoot, operation }, () =>
      abortGitOperation(repoRoot, operation)
    )
  })

  ipcMain.handle('git:stash-list', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stash-list', { repoRoot }, () => listGitStashes(repoRoot))
  })

  ipcMain.handle('git:stash-push', async (_, repoRoot: string, message: string, includeUntracked?: boolean) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stash-push', { repoRoot, includeUntracked }, () =>
      pushGitStash(repoRoot, message, includeUntracked)
    )
  })

  ipcMain.handle('git:stash-apply', async (_, repoRoot: string, index: number, expectedHash: string, pop?: boolean) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stash-apply', { repoRoot, index, pop }, () =>
      applyGitStash(repoRoot, index, expectedHash, pop)
    )
  })

  ipcMain.handle('git:stash-drop', async (_, repoRoot: string, index: number, expectedHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stash-drop', { repoRoot, index }, () =>
      dropGitStash(repoRoot, index, expectedHash)
    )
  })

  ipcMain.handle('git:checkout-commit', async (_, repoRoot: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'checkout-commit', { repoRoot, commitHash }, () => checkoutGitCommit(repoRoot, commitHash))
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

  // --- Changelists and patches (git-commit-window T6) ------------------------
  // A changelist is the app's own named set of paths, per repository; the store
  // (src/main/git-changelists.ts) prunes against `git status` on every one of
  // these, so every answer below is already reconciled with the working tree.
  // Each returns the WHOLE list set rather than an ok/error, because the panel
  // re-renders from it and a partial answer would leave two truths on screen.
  ipcMain.handle('git:changelists:get', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-get', { repoRoot }, () =>
      getGitChangelists(paths.userDataDir, repoRoot)
    )
  })

  ipcMain.handle('git:changelists:set-active', async (_, repoRoot: string, id: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-set-active', { repoRoot, id }, () =>
      setActiveGitChangelist(paths.userDataDir, repoRoot, id)
    )
  })

  ipcMain.handle(
    'git:changelists:create',
    async (_, repoRoot: string, input: { name: string; comment?: string; activate?: boolean; paths?: string[] }) => {
      return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-create', { repoRoot }, () =>
        createGitChangelist(paths.userDataDir, repoRoot, input)
      )
    }
  )

  ipcMain.handle(
    'git:changelists:rename',
    async (_, repoRoot: string, id: string, input: { name: string; comment?: string }) => {
      return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-rename', { repoRoot, id }, () =>
        renameGitChangelist(paths.userDataDir, repoRoot, id, input)
      )
    }
  )

  ipcMain.handle('git:changelists:delete', async (_, repoRoot: string, id: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-delete', { repoRoot, id }, () =>
      deleteGitChangelist(paths.userDataDir, repoRoot, id)
    )
  })

  ipcMain.handle('git:changelists:move-paths', async (_, repoRoot: string, id: string, filePaths: string[]) => {
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'changelists-move-paths',
      { repoRoot, id, pathCount: filePaths.length },
      () => moveGitChangelistPaths(paths.userDataDir, repoRoot, id, filePaths)
    )
  })

  // The patch text comes from `git diff`, never from the renderer's rows — the
  // panel has paths and nothing else, and a patch assembled from what a list
  // was showing is a patch `git apply` refuses.
  ipcMain.handle('git:create-patch', async (_, repoRoot: string, filePaths: string[], cached?: boolean) => {
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'create-patch',
      { repoRoot, pathCount: filePaths.length, cached: cached === true },
      () => createGitPatch(repoRoot, filePaths, { cached })
    )
  })

  // Save-as for the same text. The dialog belongs to main because the window it
  // must be modal to does.
  ipcMain.handle('git:save-patch', async (event, repoRoot: string, patch: string, defaultFileName?: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'save-patch', { repoRoot, length: patch.length }, async () => {
      const { BrowserWindow, dialog } = await import('electron')
      const owner = BrowserWindow.fromWebContents(event.sender)
      const suggestion = defaultFileName || suggestedPatchFileName(repoRoot)
      const result = owner
        ? await dialog.showSaveDialog(owner, {
            title: 'Create patch',
            defaultPath: join(repoRoot, suggestion),
            filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
          })
        : await dialog.showSaveDialog({
            title: 'Create patch',
            defaultPath: join(repoRoot, suggestion),
            filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
          })
      if (result.canceled || !result.filePath) return { ok: true, path: null, message: null }
      try {
        await writeFile(result.filePath, patch, 'utf-8')
        return { ok: true, path: result.filePath, message: null }
      } catch (error) {
        return { ok: false, path: null, message: error instanceof Error ? error.message : String(error) }
      }
    })
  })
}
