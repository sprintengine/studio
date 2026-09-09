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

/**
 * A WHOLE-FILE move — the toolbar's `‹ 2/27 files ›` stepper and ⌘↑ / ⌘↓
 * (git-commit-window T4), as opposed to the hunk stepping above.
 *
 * Three things it deliberately does not do:
 *
 * - **It does not wrap.** Past the last file is `none`, exactly as the hunk
 *   walk stops at the last hunk of the last file. The stepper's chevrons
 *   disable there rather than looping, so a person paging through 27 files
 *   never lands back on file 1 without asking to.
 * - **It does not skip a file with no hunks.** The move is `{type:'file'}`
 *   like a hunk overflow's, so the caller resolves it through the same
 *   `pendingEdgeRef` / `resolveEdgeHunkIndex` path — and that path clamps an
 *   empty diff to hunk 0 rather than stepping over the file. A binary or
 *   mode-only change IS one of the 27; the counter would lie if it could not
 *   be reached.
 * - **It always lands on `first`.** Stepping to the *file* means the top of it
 *   in both directions; only a hunk walk that fell off the top of a file wants
 *   the previous file's last hunk.
 */
export function navigateFile(
  fileIndex: number,
  direction: 'next' | 'prev',
  fileCount: number
): DiffNavMove {
  if (fileCount <= 0 || fileIndex < 0) return { type: 'none' }
  const target = direction === 'next' ? fileIndex + 1 : fileIndex - 1
  if (target < 0 || target > fileCount - 1) return { type: 'none' }
  return { type: 'file', fileIndex: target, edge: 'first' }
}
