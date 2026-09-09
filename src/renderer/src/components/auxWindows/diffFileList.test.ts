import assert from 'node:assert/strict'

import type { GitStatusSnapshot } from '../../../../shared/electron-api'
import { buildDiffFileList, findDiffFocusIndex } from './diffFileList'

testOrdersStagedThenUnstaged()
testPartiallyStagedAppearsTwice()
testExcludesConflicts()
testFindsExactFocus()
testFocusFallsBackToPath()

console.log('diffFileList.test.ts: ok')

function snapshot(entries: GitStatusSnapshot['files']): GitStatusSnapshot {
  return { repoRoot: '/repo', files: entries, operation: null, updatedAt: 0 }
}

function testOrdersStagedThenUnstaged(): void {
  const items = buildDiffFileList(
    snapshot({
      b: { path: '/repo/b.ts', relativePath: 'b.ts', status: 'modified', staged: false, unstaged: true },
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'new', staged: true, unstaged: false },
      c: { path: '/repo/c.ts', relativePath: 'c.ts', status: 'modified', staged: true, unstaged: false },
    })
  )
  assert.deepEqual(
    items.map((item) => `${item.kind}:${item.relativePath}`),
    ['staged:a.ts', 'staged:c.ts', 'unstaged:b.ts']
  )
}

function testPartiallyStagedAppearsTwice(): void {
  const items = buildDiffFileList(
    snapshot({
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'modified', staged: true, unstaged: true },
    })
  )
  assert.deepEqual(
    items.map((item) => item.kind),
    ['staged', 'unstaged']
  )
}

function testExcludesConflicts(): void {
  const items = buildDiffFileList(
    snapshot({
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'conflicted', staged: true, unstaged: true },
    })
  )
  assert.equal(items.length, 0)
}

function testFindsExactFocus(): void {
  const items = buildDiffFileList(
    snapshot({
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'modified', staged: true, unstaged: true },
    })
  )
  assert.equal(findDiffFocusIndex(items, '/repo/a.ts', 'unstaged'), 1)
  assert.equal(findDiffFocusIndex(items, '/repo/a.ts', 'staged'), 0)
}

function testFocusFallsBackToPath(): void {
  const items = buildDiffFileList(
    snapshot({
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'new', staged: true, unstaged: false },
    })
  )
  // Requested unstaged scope but only a staged entry exists → falls back to it.
  assert.equal(findDiffFocusIndex(items, '/repo/a.ts', 'unstaged'), 0)
  // Unknown path with entries present → NO index. The conversation peek's
  // changed-files list asks about paths from an agent's own edit ledger, which
  // can name a file this list does not hold; answering 0 opened an unrelated
  // file and said nothing about it.
  assert.equal(findDiffFocusIndex(items, '/repo/zzz.ts', null), -1)
  // No entries → -1.
  assert.equal(findDiffFocusIndex([], '/repo/a.ts', null), -1)
}
