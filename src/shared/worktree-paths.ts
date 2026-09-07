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
import { basename, parentPath, pathJoin, pathSeparatorFor, trimPath } from './paths'

/**
 * Directory name every worktree container is nested under. Named so the
 * derivation and its inverse ({@link repoRootFromWorktreePath}) can never drift
 * apart from each other.
 */
export const WORKTREE_CONTAINER_DIR = '.multicode-worktrees'

/**
 * Container directory a repo's worktrees live under:
 * `<repo-parent>/.multicode-worktrees/<repo>`. Single source of truth for the
 * convention, shared by the Worktree manager, connector chats, and
 * agent-at-spawn worktrees.
 */
export function worktreeContainerPath(repoRoot: string): string {
  return pathJoin(parentPath(repoRoot), WORKTREE_CONTAINER_DIR, basename(repoRoot))
}

/**
 * The inverse of {@link worktreeContainerPath}: given a path inside a container,
 * recover the repo checkout the worktree was cut from
 * (`<parent>/.multicode-worktrees/<repo>/<slug…>` → `<parent>/<repo>`). Null for
 * any path that is not inside a container.
 *
 * This is the fallback for worktree-backed workspaces recorded before they
 * started carrying their parent project explicitly, so the sidebar can still
 * file them under the project they came from rather than founding a header
 * named after the slug.
 *
 * Empty segments are deliberately kept when splitting: the leading one restores
 * a POSIX root, and a Windows path keeps its `C:` drive as an ordinary segment.
 * A slug may itself contain `/` (slugifyWorktreeName allows it), so anything
 * past `<repo>` is treated as slug and simply dropped.
 */
export function repoRootFromWorktreePath(pathValue: string): string | null {
  const segments = trimPath(pathValue).split(/[\\/]/)
  const marker = segments.lastIndexOf(WORKTREE_CONTAINER_DIR)
  // Nothing before the marker means no parent to rebuild from; fewer than three
  // segments from it means no `<repo>` plus at least one slug segment.
  if (marker < 1 || segments.length - marker < 3) return null
  return [...segments.slice(0, marker), segments[marker + 1]].join(pathSeparatorFor(pathValue))
}

/**
 * Peel a path out of every container it sits in. A worktree cut from a worktree
 * nests its container, so one pass would land on the intermediate worktree
 * rather than the project. Bounded rather than unbounded because this runs on
 * persisted user strings; nothing legitimate nests more than once or twice.
 */
function peelToRepoRoot(pathValue: string): string {
  let current = pathValue
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = repoRootFromWorktreePath(current)
    if (!parent) return current
    current = parent
  }
  return current
}

/**
 * The project a workspace record files under: its own folder, or — for a
 * worktree-backed one — the checkout the worktree was cut from. Grouping,
 * ordering, "New chat in project" and forgetting a project all ask this one
 * question, and main's own registry ordering has to answer it the same way the
 * renderer does, which is why it lives here rather than in the renderer util.
 *
 * The recorded `worktree.repoRoot` wins over the path convention (it is the
 * app's own spelling of the path, where the convention only recovers git's);
 * a row written before that field existed derives from the container instead.
 * Either way the answer is peeled to a non-container path, so a nested worktree
 * files under the real project and never under an intermediate worktree.
 */
export function workspaceProjectRootOf(
  record: { folderPath?: string | null; worktree?: { repoRoot?: string } | null }
): string | null {
  const folderPath = record.folderPath?.trim() || null
  if (!folderPath) return null
  return peelToRepoRoot(record.worktree?.repoRoot?.trim() || folderPath)
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
