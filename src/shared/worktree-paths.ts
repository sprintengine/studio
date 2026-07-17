/**
 * Pure worktree path/branch derivation, shared by the renderer and the main
 * process. No Node `path` dependency — string-only, over the canonical helpers
 * in `./paths`.
 *
 * Relocated from `src/renderer/src/utils/workspaceWorktree.ts` so the main
 * process can derive agent worktree paths without importing renderer code
 * (the shared-cannot-import-main / renderer boundary). The renderer util
 * re-exports these, so every existing import site keeps working unchanged.
 */
import { basename, parentPath, pathJoin } from './paths'

/**
 * Container directory a repo's worktrees live under:
 * `<repo-parent>/.multicode-worktrees/<repo>`. Single source of truth for the
 * convention, shared by the Worktree manager, connector chats, and
 * agent-at-spawn worktrees.
 */
export function worktreeContainerPath(repoRoot: string): string {
  return pathJoin(parentPath(repoRoot), '.multicode-worktrees', basename(repoRoot))
}

/** Normalize a user-facing worktree name into a directory/branch-safe slug. */
export function slugifyWorktreeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}

/**
 * Resolve the git worktree location for an agent spawned with "create a
 * worktree", placing it under the same container the Worktree manager and
 * connector chats use. Branch is `agent/<slug>` so agent worktrees group
 * together in branch listings. Null when the name yields no usable slug.
 */
export function agentWorktreePaths(
  repoRoot: string,
  name: string,
): { containerPath: string; destinationPath: string; slug: string; branchName: string } | null {
  const slug = slugifyWorktreeName(name)
  if (!slug) return null
  const containerPath = worktreeContainerPath(repoRoot)
  return {
    containerPath,
    destinationPath: pathJoin(containerPath, slug),
    slug,
    branchName: `agent/${slug}`,
  }
}
