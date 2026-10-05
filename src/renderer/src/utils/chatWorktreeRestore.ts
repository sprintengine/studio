import { repoRootFromWorktreePath } from '../../../shared/worktree-paths'
import { showToast } from '../store/toastStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { Workspace, WorkspaceId } from '../types/workspace'
import { isSettledWorkspace } from './workspaceSettle'

/**
 * The way back into a chat whose worktree was given back.
 *
 * A settled chat in a worktree of its own offers that worktree to the agent
 * worktree cleanup (`agentWorktreeCleanupPlan`), which removes it once its
 * work is merged and clean and keeps the branch. Coming back to the chat —
 * opening it, its terminals or its conversation starting — checks the
 * worktree out again from that branch, at the same path, before anything runs
 * there: the chat's records (its folder, its agents' working directories,
 * their resumable sessions) all name that path, so the same path is what
 * makes the chat whole again rather than a new checkout somewhere else.
 *
 * Asked of every chat that might need it: one marked `worktree.reclaimedAt`
 * by the sweep, settled or not by now, and a settled chat on an `agent/`
 * branch whose folder is gone (a sweep whose report never reached the store
 * still removed it; the sweep takes no other branch, so no other worktree is
 * recreated this way). Anything else answers at once. A marked chat always
 * asks main, which knows a worktree from whatever else may sit at the path;
 * an unmarked one is satisfied by its folder being there. One restore per
 * chat at a time; every caller waits on the same one.
 *
 * When it cannot be done, the person is told why and the chat shows its folder
 * as missing. The mark stays, so the next return tries again (the volume is
 * mounted again, the branch was freed), unless main says no retry can work —
 * the branch was deleted — when the mark is dropped and the chat is not asked
 * about again this run. A reason already shown is not shown again.
 */
const inFlight = new Map<WorkspaceId, Promise<boolean>>()
// Chats main refused for good this run: their folder stays missing, quietly.
const refused = new Set<WorkspaceId>()
// The reason last shown for each chat whose restore failed.
const reasonShown = new Map<WorkspaceId, string>()

// The only branches the agent worktree cleanup removes a worktree of
// (agent-worktree-cleanup.ts): a `sprintengine/<slug>` worktree opened as a
// workspace, or one named by hand, never went that way.
const AGENT_BRANCH_PREFIX = 'agent/'

type RestoreCandidate = Workspace & { folderPath: string; worktree: { branch: string } }

function restoreCandidate(workspace: Workspace | undefined): workspace is RestoreCandidate {
  if (!workspace?.folderPath || !workspace.worktree?.branch) return false
  // A chat on another machine has its folder there, and its own way back.
  if (workspace.environment || workspace.remoteOrigin) return false
  if (workspace.worktree.reclaimedAt !== undefined) return true
  return isSettledWorkspace(workspace) && workspace.worktree.branch.startsWith(AGENT_BRANCH_PREFIX)
}

/**
 * Make sure a chat's worktree is on disk, bringing it back if the cleanup gave
 * it back. Resolves false only when it is missing and could not be restored.
 */
export function ensureChatWorktree(workspaceId: WorkspaceId): Promise<boolean> {
  const pending = inFlight.get(workspaceId)
  if (pending) return pending
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  if (!restoreCandidate(workspace)) return Promise.resolve(true)
  const run = restore(workspace).finally(() => inFlight.delete(workspaceId))
  inFlight.set(workspaceId, run)
  return run
}

async function restore(workspace: RestoreCandidate): Promise<boolean> {
  const { id, folderPath, worktree } = workspace
  if (worktree.reclaimedAt === undefined) {
    // Never gone, or already back. Only for an unmarked chat: for a marked one
    // something at the path is not proof the worktree is.
    if (await window.api.pathExists(folderPath).catch(() => false)) return true
    if (refused.has(id)) return false
  }
  const repoRoot = worktree.repoRoot?.trim() || repoRootFromWorktreePath(folderPath)
  const result = repoRoot
    ? await window.api
        .restoreGitWorktree({
          repoRoot,
          path: folderPath,
          branchName: worktree.branch,
          copyIncludedFiles: true,
          // The chat exists by now, but creation named the branch as the owner
          // and the lock says the same thing again.
          agentLockOwner: worktree.branch,
          ...(workspace.hostId ? { hostId: workspace.hostId } : {}),
        })
        .catch((error: unknown) => ({
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        }))
    : { ok: false as const, definitive: true as const, message: `No project is recorded for ${folderPath}.` }

  const after = useWorkspaceStore.getState()
  after.setFolderMissing(id, !result.ok)
  if (result.ok) {
    refused.delete(id)
    reasonShown.delete(id)
    after.setWorkspaceWorktreeReclaimed(id, null)
    return true
  }
  if ('definitive' in result && result.definitive) {
    refused.add(id)
    after.setWorkspaceWorktreeReclaimed(id, null)
  }
  if (reasonShown.get(id) !== result.message) {
    reasonShown.set(id, result.message)
    showToast({
      tone: 'error',
      title: 'Could not bring back this chat’s worktree',
      description: result.message,
    })
  }
  return false
}
