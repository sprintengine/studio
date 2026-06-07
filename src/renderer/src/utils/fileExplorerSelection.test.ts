import assert from 'node:assert/strict'
import { fileExplorerSelectionFromVerticalRange, fileExplorerSelectionRange } from './fileExplorerSelection'

const paths = ['/repo/a', '/repo/b', '/repo/c', '/repo/d']

assert.deepEqual(
  fileExplorerSelectionRange(paths, '/repo/a', '/repo/c'),
  ['/repo/a', '/repo/b', '/repo/c'],
  'selects the inclusive forward range'
)

assert.deepEqual(
  fileExplorerSelectionRange(paths, '/repo/d', '/repo/b'),
  ['/repo/b', '/repo/c', '/repo/d'],
  'selects the inclusive reverse range'
)

assert.deepEqual(
  fileExplorerSelectionRange(paths, '/repo/missing', '/repo/c'),
  ['/repo/c'],
  'falls back to target-only selection when the anchor is no longer visible'
)

assert.deepEqual(
  fileExplorerSelectionRange(paths, '/repo/a', '/repo/missing'),
  [],
  'returns no selection when the target is not visible'
)

const rowBounds = [
  { path: '/repo/a', top: 10, bottom: 34 },
  { path: '/repo/b', top: 35, bottom: 59 },
  { path: '/repo/c', top: 60, bottom: 84 },
  { path: '/repo/d', top: 85, bottom: 109 },
]

assert.deepEqual(
  fileExplorerSelectionFromVerticalRange(rowBounds, 130, 72),
  ['/repo/c', '/repo/d'],
  'selects rows intersecting an upward drag from below the visible rows'
)

assert.deepEqual(
  fileExplorerSelectionFromVerticalRange(rowBounds, 20, 93),
  ['/repo/a', '/repo/b', '/repo/c', '/repo/d'],
  'selects rows intersecting a downward drag'
)

assert.deepEqual(
  fileExplorerSelectionFromVerticalRange(rowBounds, 130, 118),
  [],
  'does not select rows when the empty-space drag has not reached a row'
)

console.log('fileExplorerSelection.test.ts: selection ranges ok')
