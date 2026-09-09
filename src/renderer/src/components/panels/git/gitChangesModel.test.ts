import assert from 'node:assert/strict'

import {
  buildGitChangeGroups,
  changeRowDomId,
  isUntrackedEntry,
  commitCounts,
  entryCheckedState,
  formatCommitCounts,
  groupCheckedState,
  groupToggleAction,
  nextCheckIntent,
  nextCursorPath,
  splitGitPath,
  toGitChangeRow,
  visibleChangeRows,
} from './gitChangesModel'

// The Changes view is a rendering of the index, so every assertion here is
// about one of three things: what the index says a row's tick is, what a click
// on a tick means, and what a group of ticks adds up to.

type Entry = GitStatusEntry

function entry(over: Partial<Entry> & { relativePath: string }): Entry {
  return {
    path: `/repo/${over.relativePath}`,
    status: 'modified',
    staged: false,
    unstaged: true,
    ...over,
  } as Entry
}

// ── The row's tick is the index ───────────────────────────────────────────────

assert.equal(entryCheckedState({ staged: true, unstaged: false }), true, 'wholly in the index is checked')
assert.equal(entryCheckedState({ staged: false, unstaged: true }), false, 'nothing in the index is unchecked')
assert.equal(entryCheckedState({ staged: true, unstaged: true }), 'mixed', 'both sides is mixed')
// git can report neither for a file that is only listed (a resolved conflict
// caught mid-refresh); it is not in the index, so it is not checked.
assert.equal(entryCheckedState({ staged: false, unstaged: false }), false)

// An untracked file arrives as unstaged/new and needs no case of its own.
const untracked = toGitChangeRow(entry({ relativePath: 'src/main/skills/repo-reader.ts', status: 'new' }))
assert.equal(untracked.checked, false, 'an untracked file is an unchecked row')
assert.equal(untracked.diffScope, 'unstaged')
assert.equal(untracked.filename, 'repo-reader.ts')
assert.equal(untracked.directory, 'src/main/skills')

// A file with no directory keeps an empty one rather than repeating its name.
assert.deepEqual(splitGitPath('swap2-top.png'), { directory: '', filename: 'swap2-top.png' })
assert.deepEqual(splitGitPath('a/b/c.ts'), { directory: 'a/b', filename: 'c.ts' })

// A wholly staged row has nothing outside the index, so its diff is HEAD↔index.
assert.equal(
  toGitChangeRow(entry({ relativePath: 'a.ts', staged: true, unstaged: false })).diffScope,
  'staged',
)
assert.equal(
  toGitChangeRow(entry({ relativePath: 'a.ts', staged: true, unstaged: true })).diffScope,
  'unstaged',
  'a partly staged row opens on the work that is NOT yet in the index',
)

// ── A click on a tick ─────────────────────────────────────────────────────────

assert.equal(nextCheckIntent(false), 'stage')
assert.equal(nextCheckIntent(true), 'unstage')
// The one that has to be right: completing a half-ticked box never throws the
// staged half away.
assert.equal(nextCheckIntent('mixed'), 'stage', 'a click on a mixed box stages the rest')

// ── The group's tri-state ─────────────────────────────────────────────────────

const on = { checked: true as const }
const off = { checked: false as const }
const part = { checked: 'mixed' as const }

assert.equal(groupCheckedState([]), false, 'an empty group is unchecked, never mixed')
assert.equal(groupCheckedState([on, on]), true)
assert.equal(groupCheckedState([off, off]), false, 'an all-untracked group is unchecked')
assert.equal(groupCheckedState([on, off]), 'mixed')
assert.equal(groupCheckedState([off, on]), 'mixed', 'order does not change the verdict')
assert.equal(groupCheckedState([part]), 'mixed', 'one partly staged file makes the group mixed')
assert.equal(groupCheckedState([on, part]), 'mixed')

// Ticking the group stages everything that is not already wholly staged; the
// already-staged rows are not re-sent.
const groupRows = [
  { path: '/repo/a', checked: true as const },
  { path: '/repo/b', checked: false as const },
  { path: '/repo/c', checked: 'mixed' as const },
]
assert.deepEqual(groupToggleAction(groupRows, true), { action: 'stage', paths: ['/repo/b', '/repo/c'] })
assert.deepEqual(groupToggleAction(groupRows, false), { action: 'unstage', paths: ['/repo/a', '/repo/c'] })
assert.deepEqual(groupToggleAction([], true), { action: 'stage', paths: [] })
assert.deepEqual(
  groupToggleAction([off, off].map((row, index) => ({ ...row, path: `/repo/${index}` })), false),
  { action: 'unstage', paths: [] },
  'unticking a group with nothing in the index asks git for nothing',
)

// ── Building the groups ───────────────────────────────────────────────────────

const snapshot: Entry[] = [
  entry({ relativePath: 'src/main/app-services.ts', staged: true, unstaged: false }),
  entry({ relativePath: 'design-system/components/modal/component.css' }),
  entry({ relativePath: 'src/main/checkpoint-store.ts', status: 'deleted' }),
  entry({ relativePath: 'swap2-top.png', status: 'new' }),
]

// `??` is a file git has never heard of. A STAGED addition is not one — it is
// in the index, its tick is on, and "Add to git" must not be offered for it.
assert.equal(isUntrackedEntry({ status: 'new', staged: false }), true)
assert.equal(isUntrackedEntry({ status: 'new', staged: true }), false, 'a staged addition is tracked')
assert.equal(isUntrackedEntry({ status: 'modified', staged: false }), false)

const flat = buildGitChangeGroups(snapshot)
assert.deepEqual(flat.map((group) => group.id), ['changes', 'untracked'])
assert.equal(flat[0].kind, 'changes')
assert.equal(flat[0].title, 'Changes')
assert.equal(flat[0].totalCount, 3)
assert.equal(flat[0].checked, 'mixed')
assert.deepEqual(
  flat[0].rows.map((row) => row.relativePath),
  [
    'design-system/components/modal/component.css',
    'src/main/app-services.ts',
    'src/main/checkpoint-store.ts',
  ],
  'sorted by path, with the untracked file lifted out into its own group',
)
// The untracked group is last, and unchecked: nothing of it is in the index, so
// one click on its box is `git add` for the lot.
assert.equal(flat[1].kind, 'untracked')
assert.equal(flat[1].title, 'Untracked files')
assert.equal(flat[1].checked, false)
assert.deepEqual(flat[1].rows.map((row) => row.relativePath), ['swap2-top.png'])

// Conflicts are their own group, above, and they carry NO box: a conflicted
// file is resolved, not ticked.
const withConflict = buildGitChangeGroups([
  ...snapshot,
  entry({ relativePath: 'src/renderer/src/App.tsx', status: 'conflicted' }),
])
assert.deepEqual(withConflict.map((group) => group.id), ['conflicts', 'changes', 'untracked'])
assert.equal(withConflict[0].checked, null, 'the conflicts group has no checkbox')
assert.equal(withConflict[1].totalCount, 3, 'a conflicted file is not also a change row')

// An empty repository still yields the Changes group, unchecked, so the header
// and its count are stable rather than appearing on the first edit. The
// untracked group is NOT drawn when nothing is untracked — an always-on empty
// group would be a heading about nothing.
const empty = buildGitChangeGroups([])
assert.equal(empty.length, 1)
assert.equal(empty[0].totalCount, 0)
assert.equal(empty[0].checked, false)

// ── The changelist partition ──────────────────────────────────────────────────
// The lists come from the store; the builder only PLACES rows, and the one rule
// it enforces alone is that a path the store has not heard of yet falls to the
// active list — the same answer main persists a moment later.

const lists = [
  { id: 'default', name: 'Changes', paths: ['src/main/checkpoint-store.ts'], active: false },
  {
    id: 'modal',
    name: 'Modal header group',
    comment: 'leading mark before the title',
    paths: ['design-system/components/modal/component.css'],
    active: true,
  },
]

const byList = buildGitChangeGroups(snapshot, { changelists: lists })
assert.deepEqual(
  byList.map((group) => group.id),
  ['changelist:modal', 'changelist:default', 'untracked'],
  'the active list is first, the default last, untracked below both',
)
assert.equal(byList[0].kind, 'changelist')
assert.equal(byList[0].title, 'Modal header group')
assert.equal(byList[0].active, true, 'and it is the one that wears the chip')
assert.equal(byList[0].comment, 'leading mark before the title')
assert.equal(byList[0].changelistId, 'modal')
assert.equal(byList[1].active, false, 'exactly one header carries the active chip')
assert.deepEqual(
  byList[0].rows.map((row) => row.relativePath),
  ['design-system/components/modal/component.css', 'src/main/app-services.ts'],
  'the file no list claims lands in the ACTIVE one, beside the file that named it',
)
assert.deepEqual(byList[1].rows.map((row) => row.relativePath), ['src/main/checkpoint-store.ts'])
assert.equal(
  byList.flatMap((group) => group.rows).length,
  4,
  'every changed file is rendered exactly once, in exactly one group',
)
assert.equal(byList[0].checked, 'mixed')
assert.equal(byList[1].checked, false)

// An untracked file is never filed into a changelist, whatever the store says
// about it: the group at the bottom is a fact about the file.
const claimingUntracked = buildGitChangeGroups(snapshot, {
  changelists: [
    { id: 'default', name: 'Changes', paths: [], active: false },
    { id: 'modal', name: 'Modal header group', paths: ['swap2-top.png'], active: true },
  ],
})
assert.deepEqual(claimingUntracked.map((group) => group.id).slice(-1), ['untracked'])
assert.deepEqual(
  claimingUntracked.find((group) => group.id === 'changelist:modal')?.rows.map((row) => row.relativePath),
  ['design-system/components/modal/component.css', 'src/main/app-services.ts', 'src/main/checkpoint-store.ts'],
)

// ── Group by ──────────────────────────────────────────────────────────────────
// The other two arrangements the toolbar offers. Untracked is its own group in
// all three, and only the tracked body is rearranged.

const byDirectory = buildGitChangeGroups(snapshot, { grouping: 'directory' })
assert.deepEqual(
  byDirectory.map((group) => group.title),
  ['design-system/components/modal', 'src/main', 'Untracked files'],
)
assert.deepEqual(byDirectory[1].rows.map((row) => row.filename), ['app-services.ts', 'checkpoint-store.ts'])
assert.equal(
  buildGitChangeGroups([entry({ relativePath: 'top.ts' })], { grouping: 'directory' })[0].title,
  'Repository root',
  'a top-level file gets a heading with a name rather than an empty one',
)

const ungrouped = buildGitChangeGroups(snapshot, { grouping: 'none', changelists: lists })
assert.deepEqual(ungrouped.map((group) => group.id), ['changes', 'untracked'])
assert.equal(ungrouped[0].totalCount, 3, 'None means one list, whatever changelists exist')

// The render cap holds rows back but never the group's verdict: the box governs
// the group, so it reads every row and a tick would stage every one of them.
const many: Entry[] = Array.from({ length: 12 }, (_, index) =>
  entry({ relativePath: `src/f${String(index).padStart(3, '0')}.ts`, staged: index < 11, unstaged: index >= 11 }),
)
const capped = buildGitChangeGroups(many, { limit: 5 })[0]
assert.equal(capped.rows.length, 5)
assert.equal(capped.allRows.length, 12)
assert.equal(capped.omittedCount, 7)
assert.equal(capped.totalCount, 12)
assert.equal(
  capped.checked,
  'mixed',
  'the one unstaged file is past the cap, and the box still says the group is partly staged',
)
assert.equal(
  groupToggleAction(capped.allRows, true).paths.length,
  1,
  'ticking the group stages the file the cap hid',
)

// ── The composer's line ───────────────────────────────────────────────────────

assert.deepEqual(commitCounts(snapshot), { checked: 1, total: 4 })
assert.equal(formatCommitCounts(commitCounts(snapshot)), '1 of 4 files')
assert.equal(formatCommitCounts({ checked: 0, total: 1 }), '0 of 1 file')
assert.equal(formatCommitCounts({ checked: 0, total: 0 }), '0 of 0 files')
// A partly staged file is counted as checked: part of it is what a commit takes.
assert.deepEqual(
  commitCounts([entry({ relativePath: 'a.ts', staged: true, unstaged: true })]),
  { checked: 1, total: 1 },
)
// Conflicts are in neither number — they have no box to be counted by.
assert.deepEqual(
  commitCounts([entry({ relativePath: 'a.ts', status: 'conflicted', staged: false, unstaged: true })]),
  { checked: 0, total: 0 },
)
// The cap cannot make the line disagree with the button beside it.
assert.deepEqual(commitCounts(many), { checked: 11, total: 12 })

// ── The keyboard walk ─────────────────────────────────────────────────────────

const groups = buildGitChangeGroups([
  ...snapshot,
  entry({ relativePath: 'src/renderer/src/App.tsx', status: 'conflicted' }),
])
assert.equal(
  visibleChangeRows(groups, () => true).length,
  4,
  'the conflicts group is not part of the checklist walk',
)
assert.equal(
  visibleChangeRows(groups, () => false).length,
  0,
  'a collapsed group is not on screen, so it is not in the walk',
)

// A row that was committed away must not take the cursor with it.
const before = ['a', 'b', 'c']
assert.equal(nextCursorPath(before, before, 'b'), 'b', 'a surviving row keeps the cursor')
assert.equal(nextCursorPath(before, ['a', 'c'], 'b'), 'c', 'the cursor lands on what took the row’s place')
assert.equal(nextCursorPath(before, ['a'], 'c'), 'a', 'a shorter list clamps to its last row')
assert.equal(nextCursorPath(before, [], 'b'), null, 'an emptied list has nowhere to put a cursor')
assert.equal(nextCursorPath(before, ['a', 'b'], null), null, 'no cursor stays no cursor')

// The DOM id survives a path with characters an id may not carry.
assert.equal(changeRowDomId('git-changes', '/repo/a b.ts'), 'git-changes-row-%2Frepo%2Fa%20b.ts')
assert.notEqual(changeRowDomId('l', '/a/b'), changeRowDomId('l', '/a b'))

console.log('ok - gitChangesModel: the checkbox is the index, and the group is the sum of its ticks')
