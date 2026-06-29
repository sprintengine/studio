import { isAbsoluteFilePath, joinFilePath, samePath } from './paths'
import type { Workspace } from '../types/workspace'

export type ResolvedWorkspaceWorktree = {
  /** Absolute git root to use for this workspace's Git view. */
  gitRoot: string
  /** Branch the worktree is checked out on, for display. */
  branch?: string
}

/**
 * Single source of truth for "is this workspace backed by a git worktree, and
 * if so what git root + branch should its Git view and terminal glyph use".
 *
 * - Sprint runs in worktree mode: derived from the already-persisted
 *   `sprintEngineState.vcs` block. `folderPath` is the parent project root, so
 *   the git root is redirected to the run worktree (project-relative
 *   `worktreePath` joined onto `folderPath`). No new persisted data.
 * - Normal worktree workspaces (opened via the Worktree manager): flagged by the
 *   explicit `workspace.worktree` marker. Their `folderPath` already *is* the
 *   worktree, so the git root stays `folderPath`; the marker only carries the
 *   branch and signals worktree-backed.
 * - Everything else: null (regular workspace, unchanged behavior).
 */
export function resolveWorkspaceWorktree(
  workspace: Pick<Workspace, 'folderPath' | 'worktree' | 'sprintEngineState'>
): ResolvedWorkspaceWorktree | null {
  const folderPath = workspace.folderPath
  if (!folderPath) return null

  const vcs = workspace.sprintEngineState?.vcs
  if (vcs?.mode === 'run_worktree' && vcs.worktreePath) {
    // `worktreePath` is project-root-relative by contract; guard against an
    // absolute value (which joinFilePath would corrupt into a nested path).
    const gitRoot = isAbsoluteFilePath(vcs.worktreePath)
      ? vcs.worktreePath
      : joinFilePath(folderPath, vcs.worktreePath)
    return { gitRoot, branch: vcs.branchName }
  }

  if (workspace.worktree) {
    return { gitRoot: folderPath, branch: workspace.worktree.branch }
  }

  return null
}

/** Minimal shape of a Git panel scope option needed to pick the worktree scope. */
export type WorktreeScopeCandidate = {
  id: string
  path: string
  branch: string | null
  missing: boolean
  locked: boolean
  prunable: boolean
}

/**
 * Pick the **healthy** scope that corresponds to a worktree-backed workspace's
 * worktree, used to default the Git panel to the worktree instead of the parent.
 *
 * Matches by path OR by branch: `git worktree list` returns realpath-resolved
 * paths, so a string-joined `gitRoot` can diverge from the listed path under a
 * symlinked project root (e.g. macOS `/tmp` → `/private/tmp`). Branch is unique
 * per worktree (git forbids the same branch in two worktrees) and symlink-
 * independent, so it recovers the match when the path comparison misses.
 *
 * Excludes `missing`/`locked`/`prunable` scopes: returning one of those would
 * fight the panel's validity-reset (which sends such scopes back to `main`),
 * causing an update loop. When the worktree is unhealthy this returns null and
 * the caller falls back to `main`.
 */
export function findHealthyWorktreeScope<T extends WorktreeScopeCandidate>(
  scopes: readonly T[],
  gitRoot: string | null,
  branch: string | null,
): T | null {
  if (!gitRoot && !branch) return null
  return (
    scopes.find(
      (scope) =>
        !scope.missing
        && !scope.locked
        && !scope.prunable
        && (
          (gitRoot != null && samePath(scope.path, gitRoot))
          || (branch != null && scope.branch === branch)
        ),
    ) ?? null
  )
}
