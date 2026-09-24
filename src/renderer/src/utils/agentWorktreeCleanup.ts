import type { AgentWorktreeCleanupReport } from '../../../shared/electron-api'
import { workspaceProjectRootOf } from '../../../shared/worktree-paths'
import type { Workspace } from '../types/workspace'
import { samePath } from './paths'

type CleanupWorkspace = Pick<Workspace, 'id' | 'folderPath' | 'worktree' | 'agents' | 'worktreeState'>

/**
 * What the agent worktree cleanup (main's agent-worktree-cleanup.ts) is asked
 * to sweep, and what it must leave alone, read off the app's own records.
 *
 * Protected — never removed, whatever git says about them:
 * - every workspace's folder: a chat opened on a worktree IS its folder, and
 *   the person can come back to it until the chat is deleted;
 * - every path an agent record points at (its worktree entry or its cwd),
 *   because a parked agent can be resumed into it;
 * - every worktree entry still `assigned` to an agent that exists, or
 *   mid-`removing`.
 *
 * An entry still marked `assigned` to an agent that no longer exists is an
 * orphan from before agents released their worktrees, and is NOT protected:
 * that is exactly the backlog this sweep exists to clear.
 *
 * Every project root the records mention is swept. Main's own rules decide
 * what in it is an agent worktree at all (`agent/<slug>` in the app's
 * container) and whether it is clean and merged.
 */
export function agentWorktreeCleanupPlan(workspaces: readonly CleanupWorkspace[]): {
  repoRoots: string[]
  protectedPaths: string[]
} {
  const protectedPaths = new Set<string>()
  const repoRoots: string[] = []
  const addRoot = (root: string | null): void => {
    if (root && !repoRoots.some((existing) => samePath(existing, root))) repoRoots.push(root)
  }

  for (const workspace of workspaces) {
    if (workspace.folderPath) protectedPaths.add(workspace.folderPath)
    addRoot(workspaceProjectRootOf(workspace))
    const entries = workspace.worktreeState?.entries ?? {}
    for (const agent of Object.values(workspace.agents ?? {})) {
      const execution = agent?.execution
      if (!execution) continue
      if (execution.cwd) protectedPaths.add(execution.cwd)
      const entry = execution.worktreeId ? entries[execution.worktreeId] : undefined
      if (entry?.path) protectedPaths.add(entry.path)
    }
    for (const entry of Object.values(entries)) {
      if (entry.status === 'removing') protectedPaths.add(entry.path)
      if (entry.status === 'assigned' && (!entry.ownerAgentId || workspace.agents?.[entry.ownerAgentId])) {
        protectedPaths.add(entry.path)
      }
    }
  }

  return { repoRoots, protectedPaths: [...protectedPaths] }
}

/** The store entries a report removed from disk, as `[workspaceId, entryId]` pairs to drop. */
export function entriesRemovedBy(
  workspaces: readonly CleanupWorkspace[],
  report: AgentWorktreeCleanupReport,
): Array<[string, string]> {
  if (report.dryRun) return []
  const removed = report.entries.filter((entry) => entry.verdict === 'removed').map((entry) => entry.path)
  if (removed.length === 0) return []
  const pairs: Array<[string, string]> = []
  for (const workspace of workspaces) {
    for (const entry of Object.values(workspace.worktreeState?.entries ?? {})) {
      if (removed.some((path) => samePath(path, entry.path))) pairs.push([workspace.id, entry.id])
    }
  }
  return pairs
}
