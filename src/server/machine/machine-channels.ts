import { createFilesystemReadHandlers } from '../../main/filesystem-read'
import { searchFiles } from '../../main/filesystem-search'
import { pathExists } from '../../main/filesystem-workspace'
import {
  commitGitChanges,
  getGitBranches,
  getGitCommitGraph,
  getGitFileAtStage,
  getGitFileBase,
  getGitStatus,
  stageGitPaths,
  unstageGitPaths,
  type GitFileStage,
} from '../../main/git'
import { checkIgnoredPaths } from '../../main/git-ignore'
import { readFileHunks, stageGitHunk, unstageGitHunk } from '../../main/git-hunks'
import { gitRepoRootFor } from '../../main/git-repo-root'
import { diffBranchSelection, listBranchSteps, readFileAtRev } from '../../main/branch-steps'
import { readRepositoryIdentityRead } from '../../main/repository-identity'
import { getWorkspaceChangeSummary } from '../../main/workspace-change-summary'
import type { GitHunkRef, GitHunkScope } from '../../shared/git/hunks'
import type { BranchStepSelection } from '../../shared/electron-api'
import { isMachineChannel, type MachineChannel } from '../../shared/machine-channels'

// A server's answers to the machine channels (shared/machine-channels.ts):
// the same modules the desktop answers them with for its own folders, run
// here, on this server's machine, for a client whose workspace is here. The
// argument order is each channel's own, as the desktop's IPC takes it.

type Handler = (...args: unknown[]) => Promise<unknown>

/** One search channel per caller, so a newer query cancels the one before (the desktop's per-window rule). */
const SEARCH_SENDER = -1

export function createMachineChannels(): (channel: string, args: unknown[]) => Promise<unknown> {
  const reads = createFilesystemReadHandlers()
  const table: Record<MachineChannel, Handler> = {
    'fs:readdir': (path) => reads.readDirectory(path as string),
    'fs:readfile': (path) => reads.readTextFile(path as string),
    'fs:read-image-data-url': (path) => reads.readImageDataUrl(path as string),
    'fs:path-exists': (path) => pathExists(path as string),
    'fs:stat': (path) => reads.statPath(path as string),
    'fs:check-workspace-folder': (path) => reads.checkWorkspaceFolder(path as string),
    'fs:search-files': (input) => searchFiles(SEARCH_SENDER, input as Parameters<typeof searchFiles>[1]),
    'git:get-repo-root': (folder) => gitRepoRootFor(folder as string),
    'git:get-status': (root) => getGitStatus(root as string),
    'git:check-ignored': async (root, paths) => Array.from(await checkIgnoredPaths(root as string, paths as string[])),
    'git:get-file-base': (root, path) => getGitFileBase(root as string, path as string),
    'git:get-file-at-stage': (root, path, stage) =>
      getGitFileAtStage(root as string, path as string, stage as GitFileStage),
    'git:get-file-at-rev': (root, rev, path) => readFileAtRev(root as string, rev as string, path as string),
    'git:get-file-hunks': (root, path, scope) => readFileHunks(root as string, path as string, scope as GitHunkScope),
    'git:get-workspace-change-summary': (checkout) => getWorkspaceChangeSummary({ checkoutPath: checkout as string }),
    'git:get-branch-steps': (checkout) => listBranchSteps(checkout as string),
    'git:get-branch-step-diff': (checkout, selection) =>
      diffBranchSelection(checkout as string, selection as BranchStepSelection),
    'git:get-branches': (root) => getGitBranches(root as string),
    'git:get-commit-graph': (root, options) =>
      getGitCommitGraph(root as string, (options as { limit?: number; skip?: number } | undefined) ?? {}),
    'git:get-repository-identity': (folder) => readRepositoryIdentityRead(folder as string),
    'git:stage': (root, paths) => stageGitPaths(root as string, paths as string[]),
    'git:unstage': (root, paths) => unstageGitPaths(root as string, paths as string[]),
    'git:stage-hunk': (ref) => stageGitHunk(ref as GitHunkRef),
    'git:unstage-hunk': (ref) => unstageGitHunk(ref as GitHunkRef),
    'git:commit': (root, message) => commitGitChanges(root as string, message as string),
  }
  return (channel, args) => {
    if (!isMachineChannel(channel)) return Promise.reject(new Error(`This server does not answer ${channel}.`))
    return table[channel](...args)
  }
}
