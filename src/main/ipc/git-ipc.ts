import type { IpcMain } from 'electron'
import { isWslHostId } from '../../shared/execution-host'
import { withGitHost } from '../git-run'
import { hostRegistry } from '../hosts/host-registry'
import { writeFile } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { diffBranchSelection, listBranchSteps, readFileAtRev } from '../branch-steps'
import { getWorkspaceChangeSummary } from '../workspace-change-summary'
import { readRepositoryIdentityRead } from '../repository-identity'
import type { GitFileStage, GitRepoOperation, GitResetMode } from '../git'
import type { AgentWorktreeCleanupInput, BranchStepSelection } from '../../shared/electron-api'
import { cleanupAgentWorktreesOnce } from '../agent-worktree-cleanup'
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
import type { Changelist } from '../../shared/git/changelists'
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
  fetchGitRemotes,
  getGitBranches,
  getGitCommitGraph,
  getGitConflictFile,
  getGitFileAtStage,
  getGitFileBase,
  getGitRepoRoot,
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
    action: () => Promise<T>,
  ): Promise<T>
}

/** Where the changelist store writes. Handed in rather than resolved here so
 *  this module stays free of `electron.app` and the store stays testable —
 *  and REQUIRED rather than defaulted, because a default of `''` would write
 *  every repository's changelists into whatever the process cwd happened to be. */
export type GitIpcPaths = {
  userDataDir: string
  /** Told which repository's changelists a mutation below just rewrote. The
   *  window that asked re-renders from the answer it gets back; every OTHER
   *  window — a second workspace window, the standalone diff window filtered
   *  to one list — learns only from this. Same channel the agent changelist
   *  feed uses (`git:changelists-changed`), so the renderer has one subscription
   *  for both kinds of writer. */
  onChangelistsChanged?: (repoRoot: string) => void
  /** Working directories of the live terminal sessions; the worktree cleanup never removes one of them. */
  livePaths?: () => string[]
}

export function registerGitIpc(ipcMain: IpcMain, diagnostics: IpcDiagnostics, paths: GitIpcPaths): void {
  // `hostId` names the machine whose git answers, for a caller that knows it
  // before any workspace does (a New chat on a WSL machine, see withGitHost).
  const scopedHost = (hostId: unknown) =>
    isWslHostId(typeof hostId === 'string' ? hostId : null) ? hostRegistry().get(hostId as string) : null

  ipcMain.handle('git:get-repo-root', async (_, folderPath: string, hostId?: unknown) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-repo-root', { folderPath }, () =>
      withGitHost(scopedHost(hostId), () => getGitRepoRoot(folderPath)),
    )
  })

  ipcMain.handle('git:get-workspace-change-summary', async (_, checkoutPath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-workspace-change-summary', { checkoutPath }, () =>
      getWorkspaceChangeSummary({ checkoutPath }),
    )
  })

  ipcMain.handle('git:get-branch-steps', async (_, checkoutPath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-branch-steps', { checkoutPath }, () =>
      listBranchSteps(checkoutPath),
    )
  })

  ipcMain.handle('git:get-branch-step-diff', async (_, checkoutPath: string, selection: BranchStepSelection) => {
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'get-branch-step-diff',
      { checkoutPath, selection: selection?.kind },
      () => diffBranchSelection(checkoutPath, selection),
    )
  })

  ipcMain.handle('git:get-file-at-rev', async (_, repoRoot: string, rev: string, filePath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-file-at-rev', { repoRoot, rev, filePath }, () =>
      readFileAtRev(repoRoot, rev, filePath),
    )
  })

  ipcMain.handle('git:get-status', async (_, repoRoot: string) => {
    return diagnostics
      .withIpcDiagnostics('GitIPC', 'get-status', { repoRoot }, async () => {
        const snapshot = await getGitStatus(repoRoot)
        return snapshot
      })
      .then((snapshot) => {
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
      async () => Array.from(await checkIgnoredPaths(repoRoot, relativePaths)),
    )
  })

  ipcMain.handle('git:get-file-base', async (_, repoRoot: string, filePath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-file-base', { repoRoot, filePath }, () =>
      getGitFileBase(repoRoot, filePath),
    )
  })

  ipcMain.handle('git:get-file-at-stage', async (_, repoRoot: string, filePath: string, stage: GitFileStage) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-file-at-stage', { repoRoot, filePath, stage }, () =>
      getGitFileAtStage(repoRoot, filePath, stage),
    )
  })

  // one-project-across-machines: which repository a folder is a clone of, for
  // the sidebar's grouping and the launch panel's machine filter. The renderer
  // gets the full read — identity AND whether the question was answered —
  // because one-colour-per-project persists a hue off the answer and must not
  // treat a spun-down volume as "no remote" (RepositoryIdentityRead).
  ipcMain.handle('git:get-repository-identity', async (_, folderPath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-repository-identity', { folderPath }, () =>
      readRepositoryIdentityRead(folderPath),
    )
  })

  ipcMain.handle('git:get-branches', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-branches', { repoRoot }, () => getGitBranches(repoRoot))
  })

  ipcMain.handle('git:get-commit-graph', async (_, repoRoot: string, options?: { limit?: number; skip?: number }) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-commit-graph', { repoRoot, ...options }, () =>
      getGitCommitGraph(repoRoot, options ?? {}),
    )
  })

  ipcMain.handle('git:get-conflict-file', async (_, repoRoot: string, filePath: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-conflict-file', { repoRoot, filePath }, () =>
      getGitConflictFile(repoRoot, filePath),
    )
  })

  ipcMain.handle('git:resolve-conflict', async (_, repoRoot: string, filePath: string, content: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'resolve-conflict', { repoRoot, filePath }, () =>
      resolveGitConflict(repoRoot, filePath, content),
    )
  })

  ipcMain.handle('git:stage', async (_, repoRoot: string, paths: string[]) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stage', { repoRoot, pathCount: paths.length }, () =>
      stageGitPaths(repoRoot, paths),
    )
  })

  ipcMain.handle('git:unstage', async (_, repoRoot: string, paths: string[]) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'unstage', { repoRoot, pathCount: paths.length }, () =>
      unstageGitPaths(repoRoot, paths),
    )
  })

  // Per-hunk staging (git-commit-window T7). The renderer NAMES a hunk — the
  // scope it was read in, its position as a hint and a fingerprint of its body
  // — and never sends a patch: main reads the diff again and writes the patch
  // itself, so nothing that crossed this boundary reaches `git apply`.
  //
  // A repo root is an absolute path or it is not a repo root. `git -C <root>`
  // resolves a relative one against whatever this process's cwd happens to be,
  // which for `stage-hunk` means writing to the index of a repository nobody
  // named — so it is checked here, the way `window:dock-diff` checks its own.
  ipcMain.handle('git:get-file-hunks', async (_, repoRoot: string, filePath: string, scope: GitHunkScope) => {
    if (!isRepoRoot(repoRoot)) return { ok: false, message: 'That repository path is not absolute.' }
    return diagnostics.withIpcDiagnostics('GitIPC', 'get-file-hunks', { repoRoot, filePath, scope }, () =>
      readFileHunks(repoRoot, filePath, scope),
    )
  })

  ipcMain.handle('git:stage-hunk', async (_, ref: GitHunkRef) => {
    if (!isRepoRoot(ref?.repoRoot)) return refusedHunkWrite()
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'stage-hunk',
      { repoRoot: ref.repoRoot, filePath: ref.filePath, index: ref.index },
      () => stageGitHunk(ref),
    )
  })

  ipcMain.handle('git:unstage-hunk', async (_, ref: GitHunkRef) => {
    if (!isRepoRoot(ref?.repoRoot)) return refusedHunkWrite()
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'unstage-hunk',
      { repoRoot: ref.repoRoot, filePath: ref.filePath, index: ref.index },
      () => unstageGitHunk(ref),
    )
  })

  ipcMain.handle('git:revert', async (_, repoRoot: string, paths: string[]) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'revert', { repoRoot, pathCount: paths.length }, () =>
      revertGitPaths(repoRoot, paths),
    )
  })

  ipcMain.handle('git:commit', async (_, repoRoot: string, message: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'commit', { repoRoot, messageLength: message.length }, () =>
      commitGitChanges(repoRoot, message),
    )
  })

  ipcMain.handle('git:push', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'push', { repoRoot }, () => pushGitBranch(repoRoot))
  })

  ipcMain.handle('git:fetch', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'fetch', { repoRoot }, () => fetchGitRemotes(repoRoot))
  })

  ipcMain.handle('git:pull-with-stash', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'pull-with-stash', { repoRoot }, () =>
      pullGitBranchWithStash(repoRoot),
    )
  })

  ipcMain.handle('git:switch-branch', async (_, repoRoot: string, branchName: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'switch-branch', { repoRoot, branchName }, () =>
      switchGitBranch(repoRoot, branchName),
    )
  })

  ipcMain.handle('git:merge-ref', async (_, repoRoot: string, ref: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'merge-ref', { repoRoot, ref }, () => mergeGitRef(repoRoot, ref))
  })

  ipcMain.handle('git:rebase-branch', async (_, repoRoot: string, ontoRef: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'rebase-branch', { repoRoot, ontoRef }, () =>
      rebaseGitBranch(repoRoot, ontoRef),
    )
  })

  ipcMain.handle('git:cherry-pick', async (_, repoRoot: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'cherry-pick', { repoRoot, commitHash }, () =>
      cherryPickGitCommit(repoRoot, commitHash),
    )
  })

  ipcMain.handle('git:revert-commit', async (_, repoRoot: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'revert-commit', { repoRoot, commitHash }, () =>
      revertGitCommit(repoRoot, commitHash),
    )
  })

  ipcMain.handle('git:reset-to-commit', async (_, repoRoot: string, commitHash: string, mode: GitResetMode) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'reset-to-commit', { repoRoot, commitHash, mode }, () =>
      resetGitBranchToCommit(repoRoot, commitHash, mode),
    )
  })

  ipcMain.handle('git:delete-branch', async (_, repoRoot: string, branchName: string, force?: boolean) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'delete-branch', { repoRoot, branchName, force }, () =>
      deleteGitBranch(repoRoot, branchName, force),
    )
  })

  ipcMain.handle('git:rename-branch', async (_, repoRoot: string, branchName: string, newName: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'rename-branch', { repoRoot, branchName, newName }, () =>
      renameGitBranch(repoRoot, branchName, newName),
    )
  })

  ipcMain.handle('git:operation-continue', async (_, repoRoot: string, operation: GitRepoOperation) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'operation-continue', { repoRoot, operation }, () =>
      continueGitOperation(repoRoot, operation),
    )
  })

  ipcMain.handle('git:operation-abort', async (_, repoRoot: string, operation: GitRepoOperation) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'operation-abort', { repoRoot, operation }, () =>
      abortGitOperation(repoRoot, operation),
    )
  })

  ipcMain.handle('git:stash-list', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stash-list', { repoRoot }, () => listGitStashes(repoRoot))
  })

  ipcMain.handle('git:stash-push', async (_, repoRoot: string, message: string, includeUntracked?: boolean) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stash-push', { repoRoot, includeUntracked }, () =>
      pushGitStash(repoRoot, message, includeUntracked),
    )
  })

  ipcMain.handle('git:stash-apply', async (_, repoRoot: string, index: number, expectedHash: string, pop?: boolean) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stash-apply', { repoRoot, index, pop }, () =>
      applyGitStash(repoRoot, index, expectedHash, pop),
    )
  })

  ipcMain.handle('git:stash-drop', async (_, repoRoot: string, index: number, expectedHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'stash-drop', { repoRoot, index }, () =>
      dropGitStash(repoRoot, index, expectedHash),
    )
  })

  ipcMain.handle('git:checkout-commit', async (_, repoRoot: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'checkout-commit', { repoRoot, commitHash }, () =>
      checkoutGitCommit(repoRoot, commitHash),
    )
  })

  ipcMain.handle(
    'git:checkout-commit-as-branch',
    async (_, repoRoot: string, branchName: string, commitHash: string) => {
      return diagnostics.withIpcDiagnostics(
        'GitIPC',
        'checkout-commit-as-branch',
        { repoRoot, branchName, commitHash },
        () => checkoutGitCommitAsBranch(repoRoot, branchName, commitHash),
      )
    },
  )

  ipcMain.handle('git:tag-from-commit', async (_, repoRoot: string, tagName: string, commitHash: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'tag-from-commit', { repoRoot, tagName, commitHash }, () =>
      createGitTagFromCommit(repoRoot, tagName, commitHash),
    )
  })

  ipcMain.handle('git:worktree:list', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'worktree-list', { repoRoot }, () => listGitWorktrees(repoRoot))
  })

  ipcMain.handle('git:worktree:create', async (_, input) => {
    return withGitHost(scopedHost(input?.hostId), () => createGitWorktree(input))
  })

  ipcMain.handle('git:worktree:remove', async (_, input) => {
    return removeGitWorktree(input)
  })

  ipcMain.handle('git:worktree:prune', async (_, repoRoot: string) => {
    return pruneGitWorktrees(repoRoot)
  })

  // Agent worktree cleanup (agent-worktree-cleanup.ts): the renderer names the
  // paths its records still use; main adds every live terminal's directory.
  ipcMain.handle('git:worktree:cleanup-agents', async (_, input: AgentWorktreeCleanupInput) => {
    if (!input || typeof input.repoRoot !== 'string' || !isRepoRoot(input.repoRoot)) {
      return { repoRoot: String(input?.repoRoot ?? ''), defaultRef: null, entries: [], dryRun: true }
    }
    const protectedPaths = Array.isArray(input.protectedPaths)
      ? input.protectedPaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
      : []
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'worktree-cleanup-agents',
      { repoRoot: input.repoRoot, dryRun: input.dryRun === true },
      () =>
        cleanupAgentWorktreesOnce(
          { repoRoot: input.repoRoot, protectedPaths, dryRun: input.dryRun === true },
          { livePaths: paths.livePaths },
        ),
    )
  })

  // --- Changelists and patches (git-commit-window T6) ------------------------
  // A changelist is the app's own named set of paths, per repository; the store
  // (src/main/git-changelists.ts) prunes against `git status` on every one of
  // these, so every answer below is already reconciled with the working tree.
  // Each returns the WHOLE list set rather than an ok/error, because the panel
  // re-renders from it and a partial answer would leave two truths on screen.
  ipcMain.handle('git:changelists:get', async (_, repoRoot: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-get', { repoRoot }, () =>
      getGitChangelists(paths.userDataDir, repoRoot),
    )
  })

  // A mutation answers the asking window with the reconciled set AND tells every
  // other window to re-read. The two are one step so no handler can forget the
  // second half: a list renamed in the panel must rename in the diff window's
  // header strip, which is a different BrowserWindow with its own copy.
  const changed = async (repoRoot: string, write: () => Promise<Changelist[]>): Promise<Changelist[]> => {
    const lists = await write()
    try {
      paths.onChangelistsChanged?.(repoRoot)
    } catch (error) {
      console.warn('[git-ipc] changelists broadcast failed', error)
    }
    return lists
  }

  ipcMain.handle('git:changelists:set-active', async (_, repoRoot: string, id: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-set-active', { repoRoot, id }, () =>
      changed(repoRoot, () => setActiveGitChangelist(paths.userDataDir, repoRoot, id)),
    )
  })

  ipcMain.handle(
    'git:changelists:create',
    async (_, repoRoot: string, input: { name: string; comment?: string; activate?: boolean; paths?: string[] }) => {
      return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-create', { repoRoot }, () =>
        changed(repoRoot, () => createGitChangelist(paths.userDataDir, repoRoot, input)),
      )
    },
  )

  ipcMain.handle(
    'git:changelists:rename',
    async (_, repoRoot: string, id: string, input: { name: string; comment?: string }) => {
      return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-rename', { repoRoot, id }, () =>
        changed(repoRoot, () => renameGitChangelist(paths.userDataDir, repoRoot, id, input)),
      )
    },
  )

  ipcMain.handle('git:changelists:delete', async (_, repoRoot: string, id: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'changelists-delete', { repoRoot, id }, () =>
      changed(repoRoot, () => deleteGitChangelist(paths.userDataDir, repoRoot, id)),
    )
  })

  ipcMain.handle('git:changelists:move-paths', async (_, repoRoot: string, id: string, filePaths: string[]) => {
    return diagnostics.withIpcDiagnostics(
      'GitIPC',
      'changelists-move-paths',
      { repoRoot, id, pathCount: filePaths.length },
      () => changed(repoRoot, () => moveGitChangelistPaths(paths.userDataDir, repoRoot, id, filePaths)),
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
      () => createGitPatch(repoRoot, filePaths, { cached }),
    )
  })

  // Save-as for the same text. The dialog belongs to main because the window it
  // must be modal to does.
  ipcMain.handle('git:save-patch', async (event, repoRoot: string, patch: string, defaultFileName?: string) => {
    return diagnostics.withIpcDiagnostics('GitIPC', 'save-patch', { repoRoot, length: patch.length }, async () => {
      const { BrowserWindow, dialog } = await import('electron')
      const owner = BrowserWindow.fromWebContents(event.sender)
      // A BARE NAME, or none. This is joined to the repository root, so
      // `../../.zshrc` or `/etc/hosts` would put the save dialog somewhere the
      // person did not ask for — and the dialog's default path is what a
      // hurried Enter accepts.
      const suggestion = bareFileName(defaultFileName) ?? suggestedPatchFileName(repoRoot)
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

/** A repository root is an absolute path, or it is not one. */
function isRepoRoot(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value)
}

/** The shape both hunk WRITES answer with, so a refusal reads like git's own. */
function refusedHunkWrite(): { ok: false; stdout: string; stderr: string; message: string } {
  return { ok: false, stdout: '', stderr: '', message: 'That repository path is not absolute.' }
}

/**
 * A file NAME — no directory in it, no climbing out of one, nothing a shell or
 * a path join would read as an instruction. Null when the caller gave nothing
 * usable, so the caller falls back to a name it made itself.
 */
export function bareFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name === '.' || name === '..') return null
  if (/[\\/]/.test(name)) return null
  // A leading dot is a hidden file, not a traversal; `..anything` is neither,
  // and a NUL byte is a path the fs layer would refuse anyway.
  if (name.includes('\0')) return null
  return name
}
