import type { GitFileStatus, GitStatusSnapshot } from '../../../../shared/electron-api'

// One navigable entry in the diff viewer. A partially-staged file appears twice
// — once as its staged diff (HEAD↔index) and once as its unstaged diff
// (index↔worktree) — mirroring how the Git panel lists it in both groups.
export type DiffFileItem = {
  path: string
  relativePath: string
  status: GitFileStatus
  // 'branch' items come from a commit step rather than the working tree
  // (the-diff-an-agent-made / changed-files-and-commit-steps); their two sides
  // are revisions, carried on BranchDiffItem in branchSteps.ts.
  kind: 'staged' | 'unstaged' | 'branch'
}

// Builds the ordered changed-file list the viewer steps through. Order matches
// the Git panel: the staged group (sorted by relative path) followed by the
// unstaged group (sorted). Conflicted files are excluded — they keep the
// dedicated Resolve flow rather than opening in the diff viewer.
export function buildDiffFileList(status: GitStatusSnapshot | null): DiffFileItem[] {
  if (!status) return []
  const entries = Object.values(status.files).filter((entry) => entry.status !== 'conflicted')
  const byPath = (a: { relativePath: string }, b: { relativePath: string }): number =>
    a.relativePath.localeCompare(b.relativePath)

  const staged: DiffFileItem[] = entries
    .filter((entry) => entry.staged)
    .sort(byPath)
    .map((entry) => ({
      path: entry.path,
      relativePath: entry.relativePath,
      status: entry.status,
      kind: 'staged',
    }))

  const unstaged: DiffFileItem[] = entries
    .filter((entry) => entry.unstaged)
    .sort(byPath)
    .map((entry) => ({
      path: entry.path,
      relativePath: entry.relativePath,
      status: entry.status,
      kind: 'unstaged',
    }))

  return [...staged, ...unstaged]
}

// Finds the list index matching a focus request. Prefers an exact (path, kind)
// match, then any entry for that path so a stale focus SCOPE still lands
// somewhere sensible.
//
// A focus PATH that matches nothing answers -1, not the first entry. Every
// caller used to hand over a path taken from this very list, so the difference
// was unobservable; the conversation peek's changed-files list is the first
// caller whose path comes from somewhere else — an agent's own edit ledger,
// which can name a file in a different worktree, or one this checkout has
// since had committed away. Answering 0 there opened an UNRELATED file with no
// signal at all, which is worse than not moving. Callers already handle -1: the
// first open resolves it to the top of the list, and a later focus change stays
// where it is.
export function findDiffFocusIndex(
  items: DiffFileItem[],
  focusPath: string | null,
  focusKind: 'staged' | 'unstaged' | null
): number {
  if (!focusPath) return items.length > 0 ? 0 : -1
  const normalized = focusPath.replace(/\\/g, '/').toLowerCase()
  const samePath = (item: DiffFileItem): boolean =>
    item.path.replace(/\\/g, '/').toLowerCase() === normalized
  if (focusKind) {
    const exact = items.findIndex((item) => samePath(item) && item.kind === focusKind)
    if (exact >= 0) return exact
  }
  return items.findIndex(samePath)
}
