// Pure hunk-navigation state machine for the diff viewer window. Kept free of
// React and Monaco so it can be unit-tested in isolation. The viewer tracks a
// `(fileIndex, hunkIndex)` cursor; arrow / F7 navigation moves the cursor within
// the current file's hunks and flows across file boundaries (down past the last
// hunk → next file's first hunk; up before the first hunk → previous file's last
// hunk). There is no wrap at the very start or end.

export type DiffNavState = { fileIndex: number; hunkIndex: number }

export type DiffNavMove =
  // Move within the current file to an exact hunk index.
  | { type: 'hunk'; fileIndex: number; hunkIndex: number }
  // Cross into another file. `edge` says whether to land on its first or last
  // hunk; the caller resolves `last` once that file's hunk count is known.
  | { type: 'file'; fileIndex: number; edge: 'first' | 'last' }
  // Already at the first/last hunk of the first/last file: do nothing.
  | { type: 'none' }

export function nextDiffPosition(
  state: DiffNavState,
  direction: 'next' | 'prev',
  currentHunkCount: number,
  fileCount: number
): DiffNavMove {
  const { fileIndex, hunkIndex } = state

  if (direction === 'next') {
    if (hunkIndex < currentHunkCount - 1) {
      return { type: 'hunk', fileIndex, hunkIndex: hunkIndex + 1 }
    }
    if (fileIndex < fileCount - 1) {
      return { type: 'file', fileIndex: fileIndex + 1, edge: 'first' }
    }
    return { type: 'none' }
  }

  if (hunkIndex > 0) {
    return { type: 'hunk', fileIndex, hunkIndex: hunkIndex - 1 }
  }
  if (fileIndex > 0) {
    return { type: 'file', fileIndex: fileIndex - 1, edge: 'last' }
  }
  return { type: 'none' }
}

// Resolves an `edge` landing into a concrete hunk index given the destination
// file's hunk count. An empty diff (binary / mode-only change) clamps to 0.
export function resolveEdgeHunkIndex(edge: 'first' | 'last', hunkCount: number): number {
  if (edge === 'first') return 0
  return Math.max(0, hunkCount - 1)
}
