import assert from 'node:assert/strict'

import {
  hasHunkGutter,
  hunkAction,
  hunkBoxes,
  hunkFileKey,
  settleOverride,
  type HunkOverride,
} from './hunkGutterModel'
import type { GitHunkView } from '../../../../shared/git/hunks'
import type { DiffFileItem } from './diffFileList'
import type { BranchDiffItem } from './branchSteps'

// What the gutter's boxes say (git-commit-window T7). The assertions are aimed
// at the two things an optimistic control gets wrong: a prediction that outlives
// the write it was predicting, and a prediction shown on the wrong file.

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

function hunk(patch: Partial<GitHunkView> = {}): GitHunkView {
  return {
    index: 0,
    oldStart: 4,
    oldLines: 1,
    newStart: 4,
    newLines: 1,
    fingerprint: '-a\n+A',
    included: false,
    ...patch,
  }
}

const unstaged: DiffFileItem = {
  path: '/repo/src/a.ts',
  relativePath: 'src/a.ts',
  status: 'modified',
  kind: 'unstaged',
}
const staged: DiffFileItem = { ...unstaged, kind: 'staged' }
const step: BranchDiffItem = {
  ...unstaged,
  kind: 'branch',
  originalRev: 'aaaaaaa',
  modifiedRev: 'bbbbbbb',
  additions: 1,
  deletions: 1,
}

run('a file is named by its kind as well as its path', () => {
  // The same file's staged and unstaged diffs are two different sets of hunks,
  // and a prediction about one must not be shown on the other.
  assert.equal(hunkFileKey(unstaged), 'unstaged:/repo/src/a.ts')
  assert.equal(hunkFileKey(staged), 'staged:/repo/src/a.ts')
  assert.equal(hunkFileKey(null), null)
})

run('a branch step carries no boxes: there is no index between two commits', () => {
  assert.equal(hasHunkGutter(unstaged), true)
  assert.equal(hasHunkGutter(staged), true)
  assert.equal(hasHunkGutter(step), false)
  assert.equal(hasHunkGutter(null), false)
})

run('a box is drawn per hunk, on the modified side, named by its line', () => {
  const boxes = hunkBoxes({
    hunks: [hunk({ index: 0, newStart: 4 }), hunk({ index: 1, newStart: 12, newLines: 0 })],
    key: 'unstaged:/repo/src/a.ts',
    override: null,
    relativePath: 'src/a.ts',
  })
  assert.equal(boxes.length, 2)
  assert.deepEqual(
    boxes.map((box) => [box.index, box.line, box.checked, box.busy]),
    [[0, 4, false, false], [1, 12, false, false]],
  )
  assert.equal(boxes[0].label, 'Include the change at line 4 of src/a.ts')
})

run('a staged hunk is drawn included, and its box says how to take it out', () => {
  const [box] = hunkBoxes({
    hunks: [hunk({ included: true, newStart: 7 })],
    key: 'staged:/repo/src/a.ts',
    override: null,
    relativePath: 'src/a.ts',
  })
  assert.equal(box.checked, true)
  assert.equal(box.label, 'Exclude the change at line 7 of src/a.ts')
  assert.equal(hunkAction(box), 'unstage')
  assert.equal(hunkAction({ checked: false }), 'stage')
})

/* ── The optimistic value ─────────────────────────────────────────────────── */

function override(patch: Partial<HunkOverride> = {}): HunkOverride {
  return { key: 'unstaged:/repo/src/a.ts', index: 1, checked: true, afterRevision: 3, ...patch }
}

run('the pending click is shown as though it had happened, and refuses a second', () => {
  const boxes = hunkBoxes({
    hunks: [hunk({ index: 0 }), hunk({ index: 1, newStart: 9 })],
    key: 'unstaged:/repo/src/a.ts',
    override: override(),
    relativePath: 'src/a.ts',
  })
  assert.deepEqual(boxes.map((box) => box.checked), [false, true])
  assert.deepEqual(boxes.map((box) => box.busy), [false, true])
  // The label follows the optimistic state, so the name a screen reader reads
  // is the same claim the picture is making.
  assert.match(boxes[1].label, /^Exclude/)
})

run('a prediction about another file is never shown on this one', () => {
  const boxes = hunkBoxes({
    hunks: [hunk({ index: 0 }), hunk({ index: 1 })],
    key: 'staged:/repo/src/a.ts',
    override: override(),
    relativePath: 'src/a.ts',
  })
  assert.deepEqual(boxes.map((box) => box.checked), [false, false])
  assert.deepEqual(boxes.map((box) => box.busy), [false, false])
})

run('a prediction dies with the read that supersedes it, right or wrong', () => {
  const pending = override({ afterRevision: 3 })
  const key = 'unstaged:/repo/src/a.ts'
  // The read it was made at, and any read that started before it, keep it.
  assert.equal(settleOverride(pending, key, 3), pending)
  assert.equal(settleOverride(pending, key, 2), pending)
  // The next completed read ends it. Not "the next read that agrees with it" —
  // a write that landed somewhere unexpected must show what actually happened,
  // or the box would lie about the index for good.
  assert.equal(settleOverride(pending, key, 4), null)
  // A file switch ends it too.
  assert.equal(settleOverride(pending, 'staged:/repo/src/a.ts', 3), null)
  assert.equal(settleOverride(pending, null, 3), null)
  assert.equal(settleOverride(null, key, 3), null)
})

if (failures > 0) {
  console.error(`${failures} failing`)
  process.exit(1)
}
console.log('hunkGutterModel.test.ts: ok')
