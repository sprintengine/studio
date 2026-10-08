import { nanoid } from 'nanoid'

import type { AgentState } from '../../../shared/agent-state'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { AgentId, WorkspaceId, WorkspaceWorktree } from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'
import { agentWorktreePaths, newChatWorktreeName, workspaceProjectRootOf } from './workspaceWorktree'

export type NewChatWorktreeResult =
  | {
      ok: true
      folderPath: string
      worktree: WorkspaceWorktree
      /**
       * How to give the worktree back if nobody takes it: the repository git
       * made it in, and its pool lease when it is a pool slot.
       */
      made?: { repoRoot: string; leaseId: string | null }
    }
  | { ok: false; message: string }

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
      // The branch names the owner: the door's other chats are created after
      // their worktree, and a chat agent's that waits on it (below) has no
      // folder yet, so neither is recorded anywhere that could name it.
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
      made: { repoRoot, leaseId: result.data.leaseId ?? null },
    }
  } catch (error) {
    return fail('Worktree failed', error instanceof Error ? error.message : String(error))
  }
}

// ── A chat that opened before its worktree ──────────────────────────────────
//
// Making a worktree takes seconds (a fetch, then the checkout), and the door
// used to hold the person on New chat for all of them. A chat agent on a
// worktree now opens at once: its workspace is filed under the project by its
// worktree marker, has no folder, and its agent carries `chatPendingWorktree`.
// The attempt below gives it the folder; until then the chat starts nothing —
// it has no root to start a session in, and its pane gates on the record.
//
// The attempt is this window's. One that is not running here — the app went
// away mid-attempt, or the window was reloaded — is never coming back, so the
// chat reads as failed, with Retry and Start in the project, rather than
// waiting on nothing.

export type PendingNewChatWorktree = NonNullable<AgentState['chatPendingWorktree']>

const attempts = new Map<WorkspaceId, Promise<boolean>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Hear when an attempt starts or settles in this window. */
export function subscribeNewChatWorktreeAttempts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether this window is making `workspaceId`'s worktree right now. */
export function newChatWorktreeAttemptRunning(workspaceId: WorkspaceId): boolean {
  return attempts.has(workspaceId)
}

/** Why a pending chat is not being made, or null while its attempt runs. */
export function pendingNewChatWorktreeFailure(
  workspaceId: WorkspaceId,
  pending: PendingNewChatWorktree,
): string | null {
  if (attempts.has(workspaceId)) return null
  return pending.failure ?? 'Studio closed before this chat’s worktree was made.'
}

function pendingChatOf(workspaceId: WorkspaceId): { agentId: AgentId; pending: PendingNewChatWorktree } | null {
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  for (const [agentId, agent] of Object.entries(workspace?.agents ?? {})) {
    if (agent.chatPendingWorktree) return { agentId, pending: agent.chatPendingWorktree }
  }
  return null
}

/**
 * Make the worktree a pending chat is waiting on, and give the chat its folder.
 * Resolves whether it did; a failure is written onto the chat, which shows it.
 * One attempt per chat at a time; a second caller waits on the first.
 */
export function prepareNewChatWorktree(workspaceId: WorkspaceId): Promise<boolean> {
  const running = attempts.get(workspaceId)
  if (running) return running
  const found = pendingChatOf(workspaceId)
  if (!found) return Promise.resolve(false)
  const { failure: _previous, ...attempt } = found.pending
  if (found.pending.failure !== undefined) {
    useWorkspaceStore.getState().updateAgent(workspaceId, found.agentId, { chatPendingWorktree: attempt })
  }
  const run = (async () => {
    const made = await createNewChatWorktree(attempt.projectFolder, attempt.name, attempt.hostId ?? null)
    // Started in the project, or closed, while the worktree was being made:
    // the chat is no longer this attempt's to finish, and nothing will ever
    // use the worktree, so it goes back now rather than at a sweep an hour on.
    const still = pendingChatOf(workspaceId)
    if (!still) {
      if (made.ok) await giveBackUnusedWorktree(made, attempt.hostId ?? null)
      return false
    }
    const store = useWorkspaceStore.getState()
    if (!made.ok) {
      store.updateAgent(workspaceId, still.agentId, { chatPendingWorktree: { ...attempt, failure: made.message } })
      return false
    }
    // The folder first: the pane gates on the pending record, so clearing it
    // first would show a chat with no folder for a frame.
    store.setWorkspaceChatFolder(workspaceId, made.folderPath, made.worktree)
    store.updateAgent(workspaceId, still.agentId, { chatPendingWorktree: undefined })
    return true
  })().finally(() => {
    attempts.delete(workspaceId)
    notify()
  })
  attempts.set(workspaceId, run)
  notify()
  return run
}

/**
 * A worktree made for a chat that went before it landed, given back the way a
 * closed chat's is, without the wait: a pool slot is returned (held instead if
 * anything in it changed), and a fresh worktree is removed only while git
 * finds it clean. One made by another machine's git is left to the sweep, as
 * this one cannot remove it. Failure is silence: the sweep still finds it.
 */
async function giveBackUnusedWorktree(
  made: Extract<NewChatWorktreeResult, { ok: true }>,
  hostId: ExecutionHostId | null,
): Promise<void> {
  if (!made.made) return
  try {
    if (made.made.leaseId) await window.api.worktreePoolAction({ kind: 'release', leaseId: made.made.leaseId })
    else if (!hostId) await window.api.removeGitWorktree({ repoRoot: made.made.repoRoot, path: made.folderPath })
  } catch {
    // Left for the sweep.
  }
}

/**
 * Give up on the worktree and run the chat in the project it was to be cut
 * from. An attempt still running finds the chat no longer waiting when it
 * lands, and gives back what it made.
 */
export function startPendingNewChatInProject(workspaceId: WorkspaceId): boolean {
  const found = pendingChatOf(workspaceId)
  if (!found) return false
  const store = useWorkspaceStore.getState()
  store.setWorkspaceChatFolder(workspaceId, found.pending.projectFolder, null)
  store.updateAgent(workspaceId, found.agentId, { chatPendingWorktree: undefined })
  return true
}
