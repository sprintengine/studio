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
  revertableRows,
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
assert.equal(toGitChangeRow(entry({ relativePath: 'a.ts', staged: true, unstaged: false })).diffScope, 'staged')
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
assert.deepEqual(groupToggleAction(groupRows, true).paths, ['/repo/b', '/repo/c'])
assert.deepEqual(groupToggleAction(groupRows, false).paths, ['/repo/a', '/repo/c'])
assert.equal(groupToggleAction(groupRows, true).action, 'stage')
assert.equal(groupToggleAction(groupRows, false).action, 'unstage')
assert.deepEqual(groupToggleAction([], true), { action: 'stage', rows: [], paths: [], partialRows: [] })
assert.deepEqual(
  groupToggleAction(
    [off, off].map((row, index) => ({ ...row, path: `/repo/${index}` })),
    false,
  ),
  { action: 'unstage', rows: [], paths: [], partialRows: [] },
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
assert.deepEqual(
  flat.map((group) => group.id),
  ['changes', 'untracked'],
)
assert.equal(flat[0].kind, 'changes')
assert.equal(flat[0].title, 'Changes')
assert.equal(flat[0].totalCount, 3)
assert.equal(flat[0].checked, 'mixed')
assert.deepEqual(
  flat[0].rows.map((row) => row.relativePath),
  ['design-system/components/modal/component.css', 'src/main/app-services.ts', 'src/main/checkpoint-store.ts'],
  'sorted by path, with the untracked file lifted out into its own group',
)
// The untracked group is last, and unchecked: nothing of it is in the index, so
// one click on its box is `git add` for the lot.
assert.equal(flat[1].kind, 'untracked')
assert.equal(flat[1].title, 'Untracked files')
assert.equal(flat[1].checked, false)
assert.deepEqual(
  flat[1].rows.map((row) => row.relativePath),
  ['swap2-top.png'],
)

// Conflicts are their own group, above, and they carry NO box: a conflicted
// file is resolved, not ticked.
const withConflict = buildGitChangeGroups([
  ...snapshot,
  entry({ relativePath: 'src/renderer/src/App.tsx', status: 'conflicted' }),
])
assert.deepEqual(
  withConflict.map((group) => group.id),
  ['conflicts', 'changes', 'untracked'],
)
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
assert.deepEqual(
  byList[1].rows.map((row) => row.relativePath),
  ['src/main/checkpoint-store.ts'],
)
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

// ── Partial rows: one file, a row in every list that owns a piece of it ──────
//
// The rule the panel rests on: a status entry draws a row in its HOME list, and
// an extra `partial` row in every list holding spans for it. The remainder — the
// hunks nobody's spans cover — is the home list's, which is why the home row is
// never marked partial and never disappears.

const spanLists = [
  { id: 'default', name: 'Changes', paths: ['src/main/checkpoint-store.ts'], active: false },
  {
    id: 'agent:nadia',
    name: 'Nadia',
    paths: ['src/main/app-services.ts'],
    spans: { 'src/main/checkpoint-store.ts': [{ start: 4, lines: 3 }] },
    active: true,
    owner: { kind: 'agent' as const, agentId: 'nadia', name: 'Nadia' },
  },
  {
    id: 'agent:otto',
    name: 'Otto',
    paths: [],
    spans: { 'src/main/checkpoint-store.ts': [{ start: 40, lines: 2 }] },
    active: false,
    owner: { kind: 'agent' as const, agentId: 'otto', name: 'Otto' },
  },
]

const withSpans = buildGitChangeGroups(snapshot, { changelists: spanLists })
const groupOf = (id: string) => {
  const found = withSpans.find((group) => group.id === id)
  assert.ok(found, `no group ${id}`)
  return found
}

assert.deepEqual(
  groupOf('changelist:agent:nadia').rows.map((row) => [row.relativePath, row.partial === true]),
  [
    ['design-system/components/modal/component.css', false],
    ['src/main/app-services.ts', false],
    ['src/main/checkpoint-store.ts', true],
  ],
  'the guest row sits with the home rows, in path order, marked partial',
)
assert.deepEqual(
  groupOf('changelist:agent:otto').rows.map((row) => [row.relativePath, row.partial === true]),
  [['src/main/checkpoint-store.ts', true]],
  'a list with nothing but spans is still a list, with one row in it',
)
assert.deepEqual(
  groupOf('changelist:default').rows.map((row) => [row.relativePath, row.partial === true]),
  [['src/main/checkpoint-store.ts', false]],
  'the home row is never partial: the remainder is the home list’s',
)
assert.equal(groupOf('changelist:agent:otto').totalCount, 1, 'a guest row counts in its list’s header')

// Every row knows which list it is standing in — the guest row's is NOT the
// file's home, which is the whole reason the panel cannot re-derive it.
const guest = groupOf('changelist:agent:otto').rows[0]
const homeRow = groupOf('changelist:default').rows[0]
assert.equal(guest.changelistId, 'agent:otto')
assert.equal(homeRow.changelistId, 'default')
assert.equal(guest.path, homeRow.path, 'the same file')
assert.notEqual(guest.key, homeRow.key, 'and never the same row key')
assert.equal(homeRow.key, homeRow.path, 'an ordinary row’s key is still its path')

// The group box, and what a click on it acts on: guest rows come back apart
// from the paths, because `git add` on that file would stage Otto's lines too.
const toggle = groupToggleAction(groupOf('changelist:agent:nadia').allRows, true)
assert.deepEqual(
  toggle.paths,
  ['/repo/design-system/components/modal/component.css'],
  'only the files this list owns whole are staged by path (app-services.ts is already in)',
)
assert.deepEqual(
  toggle.partialRows.map((row) => row.relativePath),
  ['src/main/checkpoint-store.ts'],
  'and the file it owns a piece of is staged a hunk at a time instead',
)
assert.equal(toggle.rows.length, 2, 'both buckets together are what the click acts on')

// A span for a path git no longer reports draws nothing: the lists follow
// status, and a row for a file that is not there is a row nobody can act on.
const goneSpan = buildGitChangeGroups(snapshot, {
  changelists: [
    { id: 'default', name: 'Changes', paths: ['src/main/app-services.ts'], active: true },
    {
      id: 'agent:otto',
      name: 'Otto',
      paths: [],
      spans: { 'src/main/gone.ts': [{ start: 1, lines: 2 }] },
      active: false,
    },
  ],
})
assert.equal(
  goneSpan.find((group) => group.id === 'changelist:agent:otto')?.totalCount,
  0,
  'a span on a file git does not report is not a row',
)

// A file an AGENT created is `??`. T6 files untracked in its own group; an
// agent's own new file belongs in the agent's list, which is where a person
// looks to see what that agent did.
const agentCreated = buildGitChangeGroups(snapshot, {
  changelists: [
    { id: 'default', name: 'Changes', paths: [], active: true },
    {
      id: 'agent:otto',
      name: 'Otto',
      paths: ['swap2-top.png'],
      active: false,
      owner: { kind: 'agent' as const, agentId: 'otto', name: 'Otto' },
    },
  ],
})
assert.deepEqual(
  agentCreated.find((group) => group.id === 'changelist:agent:otto')?.rows.map((row) => row.relativePath),
  ['swap2-top.png'],
  'the untracked file an agent created draws in that agent’s list',
)
assert.equal(
  agentCreated.some((group) => group.kind === 'untracked'),
  false,
  'and not also in the untracked group — a file is one row',
)
// A hand-made list keeps T6's rule exactly: nothing about the file changed.
assert.deepEqual(
  claimingUntracked.map((group) => group.id).slice(-1),
  ['untracked'],
  'a list with no owner still leaves untracked files where T6 put them',
)

// Discard and delete take the whole FILE, and a guest row is a claim on some of
// its lines — so those rows are skipped and counted rather than acted on. The
// count is what the confirm dialog spends saying which files it will not touch.
{
  const home = groupOf('changelist:default').rows[0]
  const other = groupOf('changelist:agent:nadia').rows[1]
  const split = revertableRows([other, guest])
  assert.deepEqual(
    split.actionable.map((row) => row.relativePath),
    ['src/main/app-services.ts'],
  )
  assert.equal(split.actionable[0].partial, undefined, 'only the whole-file row survives')
  assert.equal(split.skippedPartial, 1, 'and the guest row is counted, not silently dropped')
  assert.deepEqual(revertableRows([guest]), { actionable: [], skippedPartial: 1 })
  assert.deepEqual(revertableRows([home]), { actionable: [home], skippedPartial: 0 })
  // ...but a guest row whose file the selection ALSO holds through its home row
  // is not "skipped": that file is about to be discarded by the row that may.
  const nadiaGuest = groupOf('changelist:agent:nadia').rows[2]
  assert.equal(nadiaGuest.partial, true)
  assert.equal(revertableRows([home, guest, nadiaGuest]).skippedPartial, 0)
  assert.equal(revertableRows([guest, nadiaGuest]).skippedPartial, 1, 'one FILE, not two rows')
}

// Directory and None arrange FILES, so spans change nothing there.
for (const grouping of ['directory', 'none'] as const) {
  const rows = buildGitChangeGroups(snapshot, { grouping, changelists: spanLists }).flatMap((group) => group.rows)
  assert.equal(rows.filter((row) => row.partial).length, 0, `${grouping} draws no partial rows`)
  assert.equal(
    rows.filter((row) => row.relativePath === 'src/main/checkpoint-store.ts').length,
    1,
    `${grouping} draws the file once`,
  )
}

// ── Group by ──────────────────────────────────────────────────────────────────
// The other two arrangements the toolbar offers. Untracked is its own group in
// all three, and only the tracked body is rearranged.

const byDirectory = buildGitChangeGroups(snapshot, { grouping: 'directory' })
assert.deepEqual(
  byDirectory.map((group) => group.title),
  ['design-system/components/modal', 'src/main', 'Untracked files'],
)
assert.deepEqual(
  byDirectory[1].rows.map((row) => row.filename),
  ['app-services.ts', 'checkpoint-store.ts'],
)
assert.equal(
  buildGitChangeGroups([entry({ relativePath: 'top.ts' })], { grouping: 'directory' })[0].title,
  'Repository root',
  'a top-level file gets a heading with a name rather than an empty one',
)

const ungrouped = buildGitChangeGroups(snapshot, { grouping: 'none', changelists: lists })
assert.deepEqual(
  ungrouped.map((group) => group.id),
  ['changes', 'untracked'],
)
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
assert.equal(groupToggleAction(capped.allRows, true).paths.length, 1, 'ticking the group stages the file the cap hid')

// ── The composer's line ───────────────────────────────────────────────────────

assert.deepEqual(commitCounts(snapshot), { checked: 1, total: 4 })
assert.equal(formatCommitCounts(commitCounts(snapshot)), '1 of 4 files')
assert.equal(formatCommitCounts({ checked: 0, total: 1 }), '0 of 1 file')
assert.equal(formatCommitCounts({ checked: 0, total: 0 }), '0 of 0 files')
// A partly staged file is counted as checked: part of it is what a commit takes.
assert.deepEqual(commitCounts([entry({ relativePath: 'a.ts', staged: true, unstaged: true })]), {
  checked: 1,
  total: 1,
})
// Conflicts are in neither number — they have no box to be counted by.
assert.deepEqual(commitCounts([entry({ relativePath: 'a.ts', status: 'conflicted', staged: false, unstaged: true })]), {
  checked: 0,
  total: 0,
})
// The cap cannot make the line disagree with the button beside it.
assert.deepEqual(commitCounts(many), { checked: 11, total: 12 })

// ── The keyboard walk ─────────────────────────────────────────────────────────

const groups = buildGitChangeGroups([
  ...snapshot,
  entry({ relativePath: 'src/renderer/src/App.tsx', status: 'conflicted' }),
])
assert.equal(visibleChangeRows(groups, () => true).length, 4, 'the conflicts group is not part of the checklist walk')
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
