import assert from 'node:assert/strict'

import {
  buildGitChangeGroups,
  changeRowDomId,
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

const flat = buildGitChangeGroups(snapshot)
assert.equal(flat.length, 1, 'no conflicts means one group')
assert.equal(flat[0].id, 'changes')
assert.equal(flat[0].kind, 'changes')
assert.equal(flat[0].title, 'Changes')
assert.equal(flat[0].totalCount, 4)
assert.equal(flat[0].checked, 'mixed')
assert.deepEqual(
  flat[0].rows.map((row) => row.relativePath),
  [
    'design-system/components/modal/component.css',
    'src/main/app-services.ts',
    'src/main/checkpoint-store.ts',
    'swap2-top.png',
  ],
  'one flat list, sorted by path — untracked files sit in it, not under it',
)

// Conflicts are their own group, above, and they carry NO box: a conflicted
// file is resolved, not ticked.
const withConflict = buildGitChangeGroups([
  ...snapshot,
  entry({ relativePath: 'src/renderer/src/App.tsx', status: 'conflicted' }),
])
assert.deepEqual(withConflict.map((group) => group.id), ['conflicts', 'changes'])
assert.equal(withConflict[0].checked, null, 'the conflicts group has no checkbox')
assert.equal(withConflict[1].totalCount, 4, 'a conflicted file is not also a change row')

// An empty repository still yields the Changes group, unchecked, so the header
// and its count are stable rather than appearing on the first edit.
const empty = buildGitChangeGroups([])
assert.equal(empty.length, 1)
assert.equal(empty[0].totalCount, 0)
assert.equal(empty[0].checked, false)

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
