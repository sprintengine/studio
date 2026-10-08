import { nanoid } from 'nanoid'

import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceWorktree } from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'
import { agentWorktreePaths, newChatWorktreeName, workspaceProjectRootOf } from './workspaceWorktree'

export type NewChatWorktreeResult =
  { ok: true; folderPath: string; worktree: WorkspaceWorktree } | { ok: false; message: string }

/**
 * The worktree the New chat door asked for under ⋯ (found at the seam of
 * checkout-and-branch-on-remote-create: the door offered the option and its
 * confirm dropped it on the floor). Same container, branch and include-set as
 * the tab strip's worktree spawn; the chat then opens IN the worktree, the way
 * the Worktree panel's "New chat here" does. When it cannot be made, a
 * diagnostic says why and the answer carries the same words — the caller
 * aborts rather than start the chat in the checkout the person asked to keep
 * clean. A thrown IPC call is one of those answers, not a rejection: the door
 * fires its confirm and forgets it, so a throw here had nowhere to be heard.
 *
 * The returned marker records the chat's project so the sidebar files it under
 * the project it was cut from instead of founding a header named after the
 * slug. It is deliberately the folder the chat was scoped to and not the
 * git-resolved `repoRoot` below: under a symlinked root git's realpath would
 * not string-match the open parent workspace's folderPath, and the chat would
 * found its own header all over again.
 *
 * The scoped folder can itself be one of our worktrees — the plain New chat
 * button inherits the active workspace's folder, and that workspace may be a
 * worktree chat. Everything here works off the PROJECT behind it, so the new
 * worktree is a sibling of the one it was started from rather than nested
 * inside its container, and records the real project as its own.
 *
 * `hostId` is the machine the chat will run on, which makes its worktree too:
 * a worktree made by another machine's git names a gitdir this one cannot
 * follow.
 */
export async function createNewChatWorktree(
  folderPath: string | null,
  requestedName: string,
  hostId?: ExecutionHostId | null,
): Promise<NewChatWorktreeResult> {
  const fail = (title: string, message: string): NewChatWorktreeResult => {
    publishDiagnosticSync({ level: 'error', source: 'workspace', title, message })
    return { ok: false, message }
  }
  if (!folderPath)
    return fail('Worktree needs a project', 'Choose a project folder before starting a chat on a worktree.')
  const projectFolder = workspaceProjectRootOf({ folderPath }) ?? folderPath
  const worktreeHostId = hostId ?? undefined
  try {
    const repoRoot = await window.api.getGitRepoRoot(projectFolder, worktreeHostId)
    if (!repoRoot) {
      return fail(
        'Worktree needs a git repository',
        'This project is not a git repository, so a worktree cannot be created.',
      )
    }
    const name = requestedName.trim() || newChatWorktreeName(nanoid(4))
    const paths = agentWorktreePaths(repoRoot, name)
    if (!paths) return fail('Worktree name invalid', `"${name}" does not reduce to a usable worktree name.`)
    // From the worktree pool, on the default branch (main's git.ts): a
    // reused slot keeps the last agent's installed dependencies. A chat on a
    // WSL machine is declined by the pool and gets a fresh worktree from that
    // machine's git, forked from the same default branch.
    const result = await window.api.createGitWorktree({
      repoRoot,
      containerPath: paths.containerPath,
      destinationPath: paths.destinationPath,
      branchName: paths.branchName,
      baseRef: 'HEAD',
      copyIncludedFiles: true,
      // The chat is created after its worktree, so the branch names the owner.
      agentLockOwner: paths.branchName,
      fromPool: true,
      ...(worktreeHostId ? { hostId: worktreeHostId } : {}),
    })
    if (!result.ok) return fail('Worktree failed', result.message)
    return {
      ok: true,
      folderPath: result.data.path,
      worktree: {
        branch: result.data.branch ?? paths.branchName,
        baseRef: result.data.baseRef,
        repoRoot: projectFolder,
      },
    }
  } catch (error) {
    return fail('Worktree failed', error instanceof Error ? error.message : String(error))
  }
}
