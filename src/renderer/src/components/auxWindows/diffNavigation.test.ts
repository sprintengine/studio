import assert from 'node:assert/strict'

import { navigateFile, nextDiffPosition, resolveEdgeHunkIndex } from './diffNavigation'

testAdvancesWithinFile()
testCrossesForwardFileBoundary()
testCrossesBackwardFileBoundary()
testStopsAtVeryEnd()
testStopsAtVeryStart()
testZeroHunkFileSkipsForward()
testResolvesEdges()
testFileStepperWalksWholeFiles()
testFileStepperDoesNotWrap()
testFileStepperReachesAHunklessFile()
testFileStepperOnAnEmptyOrUnfocusedList()

console.log('diffNavigation.test.ts: ok')

function testAdvancesWithinFile(): void {
  assert.deepEqual(
    nextDiffPosition({ fileIndex: 0, hunkIndex: 0 }, 'next', 3, 2),
    { type: 'hunk', fileIndex: 0, hunkIndex: 1 }
  )
  assert.deepEqual(
    nextDiffPosition({ fileIndex: 0, hunkIndex: 2 }, 'prev', 3, 2),
    { type: 'hunk', fileIndex: 0, hunkIndex: 1 }
  )
}

function testCrossesForwardFileBoundary(): void {
  // Past the last hunk of file 0 → first hunk of file 1.
  assert.deepEqual(
    nextDiffPosition({ fileIndex: 0, hunkIndex: 2 }, 'next', 3, 2),
    { type: 'file', fileIndex: 1, edge: 'first' }
  )
}

function testCrossesBackwardFileBoundary(): void {
  // Before the first hunk of file 1 → last hunk of file 0.
  assert.deepEqual(
    nextDiffPosition({ fileIndex: 1, hunkIndex: 0 }, 'prev', 4, 2),
    { type: 'file', fileIndex: 0, edge: 'last' }
  )
}

function testStopsAtVeryEnd(): void {
  assert.deepEqual(
    nextDiffPosition({ fileIndex: 1, hunkIndex: 2 }, 'next', 3, 2),
    { type: 'none' }
  )
}

function testStopsAtVeryStart(): void {
  assert.deepEqual(
    nextDiffPosition({ fileIndex: 0, hunkIndex: 0 }, 'prev', 3, 2),
    { type: 'none' }
  )
}

function testZeroHunkFileSkipsForward(): void {
  // A binary / mode-only file has no hunks; next should move straight on.
  assert.deepEqual(
    nextDiffPosition({ fileIndex: 0, hunkIndex: 0 }, 'next', 0, 2),
    { type: 'file', fileIndex: 1, edge: 'first' }
  )
}

function testResolvesEdges(): void {
  assert.equal(resolveEdgeHunkIndex('first', 5), 0)
  assert.equal(resolveEdgeHunkIndex('last', 5), 4)
  assert.equal(resolveEdgeHunkIndex('last', 0), 0)
}

// ── The file stepper (T4) ────────────────────────────────────────────────────

function testFileStepperWalksWholeFiles(): void {
  // One press, one file — regardless of how many hunks the current file has
  // left, which is the whole difference from the hunk walk above.
  assert.deepEqual(navigateFile(0, 'next', 27), { type: 'file', fileIndex: 1, edge: 'first' })
  assert.deepEqual(navigateFile(26, 'prev', 27), { type: 'file', fileIndex: 25, edge: 'first' })
  // Backwards lands on the TOP of the previous file, not its last hunk.
  assert.equal(navigateFile(5, 'prev', 27).type === 'file' && navigateFile(5, 'prev', 27).edge, 'first')
}

function testFileStepperDoesNotWrap(): void {
  assert.deepEqual(navigateFile(26, 'next', 27), { type: 'none' })
  assert.deepEqual(navigateFile(0, 'prev', 27), { type: 'none' })
  // A single-file list has nowhere to go in either direction.
  assert.deepEqual(navigateFile(0, 'next', 1), { type: 'none' })
  assert.deepEqual(navigateFile(0, 'prev', 1), { type: 'none' })
}

function testFileStepperReachesAHunklessFile(): void {
  // The move is the same `{type:'file'}` a hunk overflow produces, so the
  // caller resolves it through resolveEdgeHunkIndex — which clamps an empty
  // diff to 0 rather than stepping over the file.
  const move = navigateFile(0, 'next', 2)
  assert.equal(move.type, 'file')
  if (move.type !== 'file') return
  assert.equal(resolveEdgeHunkIndex(move.edge, 0), 0)
}

function testFileStepperOnAnEmptyOrUnfocusedList(): void {
  assert.deepEqual(navigateFile(0, 'next', 0), { type: 'none' })
  assert.deepEqual(navigateFile(-1, 'next', 3), { type: 'none' })
}
