import assert from 'node:assert/strict'

import {
  DEFAULT_DIFF_EDITOR_PREFS,
  differenceCounterLabel,
  diffEditorOptions,
  headerStripModel,
  includeAction,
  includeBoxState,
  includedHunkCount,
  isIncludable,
  liveDiffEditorOptions,
  shortRev,
  type DiffEditorPrefs,
} from './diffToolbarModel'
import type { DiffFileItem } from './diffFileList'
import type { BranchDiffItem } from './branchSteps'

// The diff window's toolbar, header strip and include box (git-commit-window
// T4). Every rule here is one an adversarial reading of the item asked about:
// a toggle that remounts Monaco, a counter that claims a number it does not
// have, a strip that names HEAD beside a file HEAD has never seen, and a box
// whose second click undoes the first.

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

function prefs(patch: Partial<DiffEditorPrefs> = {}): DiffEditorPrefs {
  return { diffView: 'side-by-side', ...DEFAULT_DIFF_EDITOR_PREFS, ...patch }
}

function working(patch: Partial<DiffFileItem> = {}): DiffFileItem {
  return {
    path: '/repo/src/a.ts',
    relativePath: 'src/a.ts',
    status: 'modified',
    kind: 'unstaged',
    ...patch,
  }
}

function branch(patch: Partial<BranchDiffItem> = {}): BranchDiffItem {
  return {
    path: '/repo/src/a.ts',
    relativePath: 'src/a.ts',
    status: 'modified',
    kind: 'branch',
    originalRev: 'aaaaaaaaaaaaaaaaaaaa1',
    modifiedRev: 'bbbbbbbbbbbbbbbbbbbb2',
    additions: 3,
    deletions: 1,
    ...patch,
  }
}

/* ── The toggle must not remount Monaco ───────────────────────────────────── */

run('every preference is applied through updateOptions, so none needs a remount', () => {
  const a = diffEditorOptions(prefs(), 'mono')
  const b = diffEditorOptions(
    prefs({ diffView: 'unified', hideUnchanged: true, wordWrap: true, ignoreTrimWhitespace: false }),
    'mono',
  )
  const live = new Set(Object.keys(liveDiffEditorOptions(prefs())))
  const changed = Object.keys(a).filter(
    (key) =>
      JSON.stringify((a as Record<string, unknown>)[key])
      !== JSON.stringify((b as Record<string, unknown>)[key]),
  )
  assert.ok(changed.length > 0, 'the preferences must change something')
  for (const key of changed) {
    assert.ok(
      live.has(key),
      `${key} changes with a preference but is not in the live option set — changing it would need a new editor`,
    )
  }
})

run('the construction options start from the preference values, not from Monaco defaults', () => {
  const unified = diffEditorOptions(prefs({ diffView: 'unified' }), 'mono')
  assert.equal(unified.renderSideBySide, false, 'a window opened on unified opens unified')
  assert.equal(diffEditorOptions(prefs(), 'mono').renderSideBySide, true)
})

run('collapse unchanged, word wrap and whitespace map to their Monaco options', () => {
  assert.deepEqual(liveDiffEditorOptions(prefs({ hideUnchanged: true })).hideUnchangedRegions, {
    enabled: true,
  })
  assert.equal(liveDiffEditorOptions(prefs({ wordWrap: true })).wordWrap, 'on')
  assert.equal(liveDiffEditorOptions(prefs()).wordWrap, 'off')
  assert.equal(liveDiffEditorOptions(prefs({ ignoreTrimWhitespace: false })).ignoreTrimWhitespace, false)
})

/* ── The include box ──────────────────────────────────────────────────────── */

run('the include box is the index: checked, dashed, or empty', () => {
  assert.deepEqual(includeBoxState({ staged: true, unstaged: false }), {
    checked: true,
    indeterminate: false,
  })
  assert.deepEqual(includeBoxState({ staged: false, unstaged: true }), {
    checked: false,
    indeterminate: false,
  })
  assert.deepEqual(includeBoxState({ staged: true, unstaged: true }), {
    checked: false,
    indeterminate: true,
  })
  // A file git has never heard of reads as not included rather than throwing.
  assert.deepEqual(includeBoxState(null), { checked: false, indeterminate: false })
})

run('a click on a mixed box completes it; only a full box unstages', () => {
  assert.equal(includeAction({ checked: false, indeterminate: false }), 'stage')
  assert.equal(includeAction({ checked: false, indeterminate: true }), 'stage')
  assert.equal(includeAction({ checked: true, indeterminate: false }), 'unstage')
})

run('a branch step carries no include box', () => {
  assert.equal(isIncludable(working()), true)
  assert.equal(isIncludable(working({ kind: 'staged' })), true)
  assert.equal(isIncludable(branch()), false)
  assert.equal(isIncludable(null), false)
})

/* ── The counter ──────────────────────────────────────────────────────────── */

run('the counter claims only what it knows', () => {
  const empty = { checked: false, indeterminate: false }
  const full = { checked: true, indeterminate: false }
  const mixed = { checked: false, indeterminate: true }
  const item = working()
  assert.equal(differenceCounterLabel({ item, differenceCount: 2, fileInclude: empty }), '2 differences')
  assert.equal(differenceCounterLabel({ item, differenceCount: 1, fileInclude: empty }), '1 difference')
  assert.equal(
    differenceCounterLabel({ item, differenceCount: 2, fileInclude: full }),
    '2 differences, all included',
  )
  // Half a file staged is NOT "all included" — the very claim the mixed state exists to deny.
  assert.equal(differenceCounterLabel({ item, differenceCount: 2, fileInclude: mixed }), '2 differences')
  // A binary or mode-only change has no hunks, and says so rather than "0 differences, all included".
  assert.equal(differenceCounterLabel({ item, differenceCount: 0, fileInclude: full }), 'No differences')
  // A branch step has no index behind it: the working tree's flags say nothing
  // about a diff between two commits.
  assert.equal(
    differenceCounterLabel({ item: branch(), differenceCount: 2, fileInclude: full }),
    '2 differences',
  )
})

run('includedHunkCount is the T7 seam and answers null until T7 fills it', () => {
  assert.equal(
    includedHunkCount({
      item: working(),
      differenceCount: 4,
      fileInclude: { checked: true, indeterminate: false },
    }),
    null,
  )
})

/* ── The header strip ─────────────────────────────────────────────────────── */

run('the strip names the two revisions the loader actually read', () => {
  assert.deepEqual(headerStripModel(working({ kind: 'staged' })), {
    base: { text: 'HEAD', mono: true },
    current: { text: 'Staged version', mono: false },
    includable: true,
  })
  assert.deepEqual(headerStripModel(working({ kind: 'unstaged' })), {
    base: { text: 'Staged version', mono: false },
    current: { text: 'Current version', mono: false },
    includable: true,
  })
  assert.equal(headerStripModel(null), null)
})

run('a side that was never there is said in words, not given a revision', () => {
  assert.deepEqual(headerStripModel(working({ kind: 'staged', status: 'new' }))?.base, {
    text: 'New file',
    mono: false,
  })
  assert.deepEqual(headerStripModel(working({ kind: 'staged', status: 'deleted' }))?.current, {
    text: 'Deleted',
    mono: false,
  })
  assert.deepEqual(headerStripModel(working({ kind: 'unstaged', status: 'new' }))?.base, {
    text: 'New file',
    mono: false,
  })
  assert.deepEqual(headerStripModel(branch({ originalRev: null, status: 'new' }))?.base, {
    text: 'New file',
    mono: false,
  })
  assert.deepEqual(headerStripModel(branch({ modifiedRev: null, status: 'deleted' }))?.current, {
    text: 'Deleted',
    mono: false,
  })
})

run('a branch step shows its own two revisions, short', () => {
  const model = headerStripModel(branch({ originalRev: 'cccccccccccccccccccc3^', modifiedRev: 'cccccccccccccccccccc3' }))
  assert.deepEqual(model?.base, { text: 'cccccccc^', mono: true })
  assert.deepEqual(model?.current, { text: 'cccccccc', mono: true })
  assert.equal(model?.includable, false)
  // The uncommitted tail's modified side IS the working tree.
  assert.deepEqual(headerStripModel(branch({ originalRev: 'HEAD', modifiedRev: 'worktree' })), {
    base: { text: 'HEAD', mono: true },
    current: { text: 'Current version', mono: false },
    includable: false,
  })
})

run('shortRev shortens an oid and leaves a name alone', () => {
  assert.equal(shortRev('0123456789abcdef0123456789abcdef01234567'), '01234567')
  assert.equal(shortRev('0123456789abcdef0123456789abcdef01234567^'), '01234567^')
  assert.equal(shortRev('HEAD'), 'HEAD')
  assert.equal(shortRev('main'), 'main')
})

if (failures > 0) {
  console.error(`${failures} failing`)
  process.exit(1)
}
console.log('diffToolbarModel.test.ts: ok')
