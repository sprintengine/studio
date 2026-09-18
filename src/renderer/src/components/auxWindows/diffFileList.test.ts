import assert from 'node:assert/strict'

import type { GitStatusSnapshot } from '../../../../shared/electron-api'
import type { Changelist } from '../../../../shared/git/changelists'
import { buildDiffFileList, findDiffFocusIndex } from './diffFileList'

testOrdersStagedThenUnstaged()
testPartiallyStagedAppearsTwice()
testExcludesConflicts()
testFindsExactFocus()
testFocusFallsBackToPath()
testChangelistKeepsHomePathsAndSpans()
testChangelistCanBeEmpty()
testNoChangelistIsUnfiltered()

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
    }),
  )
  assert.deepEqual(
    items.map((item) => `${item.kind}:${item.relativePath}`),
    ['staged:a.ts', 'staged:c.ts', 'unstaged:b.ts'],
  )
}

function testPartiallyStagedAppearsTwice(): void {
  const items = buildDiffFileList(
    snapshot({
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'modified', staged: true, unstaged: true },
    }),
  )
  assert.deepEqual(
    items.map((item) => item.kind),
    ['staged', 'unstaged'],
  )
}

function testExcludesConflicts(): void {
  const items = buildDiffFileList(
    snapshot({
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'conflicted', staged: true, unstaged: true },
    }),
  )
  assert.equal(items.length, 0)
}

function testFindsExactFocus(): void {
  const items = buildDiffFileList(
    snapshot({
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'modified', staged: true, unstaged: true },
    }),
  )
  assert.equal(findDiffFocusIndex(items, '/repo/a.ts', 'unstaged'), 1)
  assert.equal(findDiffFocusIndex(items, '/repo/a.ts', 'staged'), 0)
}

function testFocusFallsBackToPath(): void {
  const items = buildDiffFileList(
    snapshot({
      a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'new', staged: true, unstaged: false },
    }),
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

// --- The changelist filter (agent changelists, Wave 4) ----------------------

function list(input: Partial<Changelist> & { id: string }): Changelist {
  return { name: input.id, paths: [], active: false, ...input }
}

function threeFiles(): GitStatusSnapshot {
  return snapshot({
    a: { path: '/repo/a.ts', relativePath: 'a.ts', status: 'modified', staged: false, unstaged: true },
    b: { path: '/repo/b.ts', relativePath: 'b.ts', status: 'modified', staged: true, unstaged: true },
    c: { path: '/repo/c.ts', relativePath: 'c.ts', status: 'modified', staged: false, unstaged: true },
  })
}

function testChangelistKeepsHomePathsAndSpans(): void {
  // `a.ts` is the list's HOME file; `b.ts` lives somewhere else and the list
  // owns a run of lines inside it. Both must be reachable, or the hunks the
  // list owns in b.ts cannot be seen from a filtered window at all.
  const items = buildDiffFileList(threeFiles(), {
    changelist: list({ id: 'agent:n', name: 'Nadia', paths: ['a.ts'], spans: { 'b.ts': [{ start: 4, lines: 2 }] } }),
  })
  assert.deepEqual(
    items.map((item) => `${item.kind}:${item.relativePath}`),
    ['staged:b.ts', 'unstaged:a.ts', 'unstaged:b.ts'],
  )
}

function testChangelistCanBeEmpty(): void {
  // The agent committed everything: an EMPTY list, never a silent fallback to
  // all changes under a header naming that agent.
  const items = buildDiffFileList(threeFiles(), { changelist: list({ id: 'agent:n', name: 'Nadia' }) })
  assert.deepEqual(items, [])
}

function testNoChangelistIsUnfiltered(): void {
  // Byte for byte the old behaviour: no option, an explicit undefined, and an
  // explicit null are all "all changes".
  const all = buildDiffFileList(threeFiles())
  assert.deepEqual(buildDiffFileList(threeFiles(), {}), all)
  assert.deepEqual(buildDiffFileList(threeFiles(), { changelist: null }), all)
  assert.equal(all.length, 4)
}
