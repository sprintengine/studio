import type { GitFileStatus, GitStatusSnapshot } from '../../../../shared/electron-api'

// One navigable entry in the diff viewer. A partially-staged file appears twice
// — once as its staged diff (HEAD↔index) and once as its unstaged diff
// (index↔worktree) — mirroring how the Git panel lists it in both groups.
export type DiffFileItem = {
  path: string
  relativePath: string
  status: GitFileStatus
  kind: 'staged' | 'unstaged'
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
// match; falls back to the first entry for the path so a stale focus scope still
// lands somewhere sensible.
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
  const anyMatch = items.findIndex(samePath)
  if (anyMatch >= 0) return anyMatch
  return items.length > 0 ? 0 : -1
}
