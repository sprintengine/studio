import assert from 'node:assert/strict'

import {
  DEFAULT_DIFF_EDITOR_PREFS,
  differenceCounterLabel,
  differenceTotal,
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
      JSON.stringify((a as Record<string, unknown>)[key]) !== JSON.stringify((b as Record<string, unknown>)[key]),
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
  assert.equal(differenceCounterLabel({ item, differenceCount: 2, fileInclude: full }), '2 differences, all included')
  // Half a file staged is NOT "all included" — the very claim the mixed state exists to deny.
  assert.equal(differenceCounterLabel({ item, differenceCount: 2, fileInclude: mixed }), '2 differences')
  // A binary or mode-only change has no hunks, and says so rather than "0 differences, all included".
  assert.equal(differenceCounterLabel({ item, differenceCount: 0, fileInclude: full }), 'No differences')
  // A branch step has no index behind it: the working tree's flags say nothing
  // about a diff between two commits.
  assert.equal(differenceCounterLabel({ item: branch(), differenceCount: 2, fileInclude: full }), '2 differences')
})

run("the counter fills in once git has counted the file's hunks", () => {
  const item = working()
  const empty = { checked: false, indeterminate: false }
  const mixed = { checked: false, indeterminate: true }
  // Both halves of the sentence come from git's summary — never git's included
  // count beside Monaco's total, which are two different numbers.
  assert.equal(
    differenceCounterLabel({ item, differenceCount: 1, fileInclude: mixed, hunkSummary: { total: 2, included: 1 } }),
    '2 differences, 1 included',
  )
  assert.equal(
    differenceCounterLabel({ item, differenceCount: 2, fileInclude: empty, hunkSummary: { total: 2, included: 0 } }),
    '2 differences, 0 included',
  )
  assert.equal(
    differenceCounterLabel({ item, differenceCount: 1, fileInclude: empty, hunkSummary: { total: 1, included: 1 } }),
    '1 difference, 1 included',
  )
  assert.equal(
    differenceTotal({ item, differenceCount: 9, fileInclude: empty, hunkSummary: { total: 2, included: 1 } }),
    2,
  )
})

run('the mixed box and the counter can never contradict each other', () => {
  // The state the whole feature is judged on: half a file staged. The summary
  // is the two diffs added up, so a mixed box always lands strictly between
  // "none included" and "all included".
  const label = differenceCounterLabel({
    item: working(),
    differenceCount: 1,
    fileInclude: { checked: false, indeterminate: true },
    hunkSummary: { total: 2, included: 1 },
  })
  assert.equal(label, '2 differences, 1 included')
  assert.equal(/all included/.test(label), false)
  assert.equal(/, 0 included/.test(label), false)
})

run('includedHunkCount answers null until somebody has actually counted', () => {
  const item = working()
  const full = { checked: true, indeterminate: false }
  assert.equal(includedHunkCount({ item, differenceCount: 4, fileInclude: full }), null)
  assert.equal(includedHunkCount({ item, differenceCount: 4, fileInclude: full, hunkSummary: null }), null)
  // Before the read lands, the only "included" fact in the building is the
  // whole file's — the pre-T7 sentence, unchanged.
  assert.equal(differenceCounterLabel({ item, differenceCount: 4, fileInclude: full }), '4 differences, all included')
})

run('a summary of zero is no answer, not an answer of nothing', () => {
  // A rename with no content change, or a mode-only change: git has no hunks
  // while Monaco still has two texts to compare. "No differences" over a full
  // screen of diff is worse than saying nothing, so the summary is ignored.
  const item = working()
  const empty = { checked: false, indeterminate: false }
  assert.equal(
    includedHunkCount({ item, differenceCount: 3, fileInclude: empty, hunkSummary: { total: 0, included: 0 } }),
    null,
  )
  assert.equal(
    differenceCounterLabel({ item, differenceCount: 3, fileInclude: empty, hunkSummary: { total: 0, included: 0 } }),
    '3 differences',
  )
})

run('a branch step is never told how much of it is included', () => {
  // Two commits with no index between them: the summary would be about the
  // working tree, which is a different thing entirely.
  assert.equal(
    includedHunkCount({
      item: branch(),
      differenceCount: 2,
      fileInclude: { checked: true, indeterminate: false },
      hunkSummary: { total: 2, included: 2 },
    }),
    null,
  )
  assert.equal(
    differenceCounterLabel({
      item: branch(),
      differenceCount: 2,
      fileInclude: { checked: true, indeterminate: false },
      hunkSummary: { total: 2, included: 2 },
    }),
    '2 differences',
  )
})

run('the glyph margin is on, because that is where the hunk boxes hang', () => {
  assert.equal(diffEditorOptions(prefs(), 'mono').glyphMargin, true)
  assert.equal(
    diffEditorOptions(prefs({ diffView: 'unified' }), 'mono').glyphMargin,
    true,
    'both views draw the margin',
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
  const model = headerStripModel(
    branch({ originalRev: 'cccccccccccccccccccc3^', modifiedRev: 'cccccccccccccccccccc3' }),
  )
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
