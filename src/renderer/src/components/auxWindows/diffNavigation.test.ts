import assert from 'node:assert/strict'

import { nextDiffPosition, resolveEdgeHunkIndex } from './diffNavigation'

testAdvancesWithinFile()
testCrossesForwardFileBoundary()
testCrossesBackwardFileBoundary()
testStopsAtVeryEnd()
testStopsAtVeryStart()
testZeroHunkFileSkipsForward()
testResolvesEdges()

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
