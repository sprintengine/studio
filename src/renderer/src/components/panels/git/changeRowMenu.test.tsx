import assert from 'node:assert/strict'

import {
  buildChangeGroupMenu,
  buildChangeRowMenu,
  PARTIAL_ROW_REASON,
  UNTRACKED_MOVE_REASON,
  type ChangeRowMenuEntry,
} from './changeRowMenu'
import type { Changelist } from '../../../../../shared/git/changelists'
import type { GitChangeGroup, GitChangeRow } from './gitChangesModel'

// The row menu and the band menu, as DATA (epic `git-commit-window`, T6;
// adversarial review). They are built as arrays precisely so they can be read
// without a DOM, and until now nothing read them.
//
// What is asserted is what a person actually meets: the ORDER (a menu whose
// shape moves with the row is a menu nobody learns), which items are
// conditional on the row being untracked, and where a shortcut HINT is spent —
// the kit's rule is that a hint may only name a key that works with the menu
// closed, and a hint that names a key belonging to another command is worse
// than no hint at all.

const LISTS: Changelist[] = [
  { id: 'default', name: 'Changes', paths: [], active: true },
  { id: 'spike', name: 'Spike', paths: ['src/a.ts'], active: false },
]

const ROW: GitChangeRow = {
  key: '/repo/src/a.ts',
  path: '/repo/src/a.ts',
  relativePath: 'src/a.ts',
  filename: 'a.ts',
  directory: 'src',
  status: 'modified',
  staged: false,
  unstaged: true,
  checked: false,
  diffScope: 'unstaged',
}

const NOOP = (): void => {}

function rowMenu(over: Partial<Parameters<typeof buildChangeRowMenu>[0]> = {}): ChangeRowMenuEntry[] {
  return buildChangeRowMenu({
    changelists: LISTS,
    currentChangelistId: 'default',
    onMoveToChangelist: NOOP,
    onMoveToNewChangelist: NOOP,
    onNewChangelist: NOOP,
    onEditChangelist: NOOP,
    onDeleteChangelist: NOOP,
    onSetActiveChangelist: NOOP,
    row: ROW,
    selectedCount: 1,
    busy: false,
    untracked: false,
    untrackedOnly: false,
    partialOnly: false,
    onCommitFiles: NOOP,
    onDiscard: NOOP,
    onShowDiff: NOOP,
    onOpenInEditor: NOOP,
    onCopyPath: NOOP,
    onDeleteFiles: NOOP,
    onAddToGit: NOOP,
    onCreatePatch: NOOP,
    onCopyAsPatch: NOOP,
    onStash: NOOP,
    onRefresh: NOOP,
    ...over,
  })
}

const ids = (entries: ChangeRowMenuEntry[]): string[] => entries.map((entry) => entry.id)
const find = (entries: ChangeRowMenuEntry[], id: string): ChangeRowMenuEntry => {
  const entry = entries.find((candidate) => candidate.id === id)
  assert.ok(entry, `no menu entry ${id}`)
  return entry
}

// ── the shape, and that it does not move under the person ────────────────────
{
  const tracked = rowMenu()
  assert.deepEqual(
    ids(tracked),
    [
      'commit-files',
      'discard',
      'move-to-changelist',
      'show-diff',
      'open-in-editor',
      'copy-path',
      'after-file',
      'delete-files',
      'after-changelists',
      'new-changelist',
      'delete-changelist',
      'edit-changelist',
      'set-active-changelist',
      'create-patch',
      'copy-as-patch',
      'stash',
      'after-repo',
      'refresh',
    ],
    'mockup 2522 panel 3, in order, with its three dividers',
  )

  // Every item renders the leading slot, filled or empty: a menu where only
  // some rows carry a mark ladders its own text.
  for (const entry of tracked) {
    if (entry.kind === 'divider') continue
    assert.ok(entry.icon, `${entry.id} leaves the leading slot unrendered`)
  }
}

// ── the untracked-only and tracked-only items ────────────────────────────────
{
  const untracked = rowMenu({ untracked: true, untrackedOnly: true })

  // "Add to git" is real only for a file git has never heard of.
  assert.ok(ids(untracked).includes('add-to-git'), 'an untracked row can be added to git')
  assert.ok(!ids(rowMenu()).includes('add-to-git'), 'a tracked one cannot — it is already added')

  // …and the move is a no-op for it, because an untracked file is drawn in the
  // untracked group whatever list holds it.
  const move = find(untracked, 'move-to-changelist')
  assert.equal(move.kind, 'item', 'no submenu of destinations that cannot be reached')
  assert.equal(move.kind === 'item' && move.disabled, true)
  assert.match(
    move.kind === 'item' ? move.label : '',
    new RegExp(UNTRACKED_MOVE_REASON),
    'and the label says why, because a disabled control cannot open a tooltip',
  )

  const trackedMove = find(rowMenu(), 'move-to-changelist')
  assert.equal(trackedMove.kind, 'submenu', 'a tracked row gets the destinations')
  assert.deepEqual(
    trackedMove.kind === 'submenu' ? ids(trackedMove.items) : [],
    ['move-to-default', 'move-to-spike', 'move-to-new', 'move-to-new-changelist'],
    'every list, the one it is already in included, then New… — so the submenu is one shape for every row',
  )
  assert.equal(
    trackedMove.kind === 'submenu' &&
      trackedMove.items.find((item) => item.id === 'move-to-default')?.kind === 'item' &&
      (trackedMove.items.find((item) => item.id === 'move-to-default') as { disabled?: boolean }).disabled,
    true,
    'moving a file to where it already is is a no-op, not an error',
  )
}

// ── the hints, and only where the key works with the menu closed ─────────────
{
  const entries = rowMenu()
  const hints = new Map(
    entries.flatMap((entry) => (entry.kind === 'item' && entry.shortcut ? [[entry.id, entry.shortcut]] : [])),
  )
  assert.deepEqual(
    Object.fromEntries(hints),
    {
      discard: '⌥⌘Z',
      'show-diff': '⌘D',
      'open-in-editor': '⌘↓',
      'delete-files': '⌫',
      'edit-changelist': 'F2',
    },
    'two global commands (⌥⌘Z, ⌘D) and three keys the changes list itself owns',
  )
  assert.equal(
    hints.has('move-to-changelist'),
    false,
    '⇧⌘M belongs to the model picker at workspace scope — a hint here would name another command',
  )
  assert.equal(
    (find(rowMenu({ untracked: true }), 'add-to-git') as { shortcut?: string }).shortcut,
    '⌥⌘A',
    'and the untracked-only item carries its own',
  )
}

// ── busy takes the acting items and leaves the reading ones ──────────────────
{
  const busy = rowMenu({ busy: true })
  for (const id of ['commit-files', 'discard', 'delete-files', 'create-patch', 'stash', 'refresh']) {
    assert.equal((find(busy, id) as { disabled?: boolean }).disabled, true, `${id} waits for the command in flight`)
  }
  for (const id of ['show-diff', 'open-in-editor', 'copy-path']) {
    assert.ok(!(find(busy, id) as { disabled?: boolean }).disabled, `${id} only reads, so it stays available`)
  }
}

// ── the band menu ────────────────────────────────────────────────────────────
{
  const group: GitChangeGroup = {
    id: 'changelist:spike',
    kind: 'changelist',
    title: 'Spike',
    changelistId: 'spike',
    totalCount: 2,
    rows: [ROW],
    allRows: [ROW],
    omittedCount: 0,
    checked: false,
  }
  const bandMenu = (over: Partial<GitChangeGroup> = {}): ChangeRowMenuEntry[] =>
    buildChangeGroupMenu({
      changelists: LISTS,
      currentChangelistId: 'spike',
      onMoveToChangelist: NOOP,
      onMoveToNewChangelist: NOOP,
      onNewChangelist: NOOP,
      onEditChangelist: NOOP,
      onDeleteChangelist: NOOP,
      onSetActiveChangelist: NOOP,
      group: { ...group, ...over },
      busy: false,
      onStageAll: NOOP,
      onUnstageAll: NOOP,
      onDiscardAll: NOOP,
      onCommitChangelist: NOOP,
      onShowChangelistDiff: NOOP,
      onRefresh: NOOP,
    })

  assert.deepEqual(
    ids(bandMenu()),
    [
      'stage-all',
      'unstage-all',
      'discard-all',
      'after-group-files',
      'commit-changelist',
      'show-changelist-diff',
      'move-to-changelist',
      'new-changelist',
      'delete-changelist',
      'edit-changelist',
      'set-active-changelist',
      'after-group-repo',
      'refresh',
    ],
    'the three "all" actions, then the two that act on the LIST, then the changelist half',
  )
  assert.equal((find(bandMenu(), 'commit-changelist') as { label: string }).label, 'Commit Spike…')
  assert.equal(
    (find(bandMenu(), 'show-changelist-diff') as { shortcut?: string }).shortcut,
    '⌘D',
    'the band’s diff item names the key the panel routes to a focused band',
  )
  // An empty list has nothing to commit and no diff to filter.
  for (const id of ['commit-changelist', 'show-changelist-diff']) {
    assert.equal(
      (find(bandMenu({ totalCount: 0, rows: [], allRows: [] }), id) as { disabled?: boolean }).disabled,
      true,
      `${id} on an empty list would act on nothing`,
    )
  }
  assert.equal(
    (find(bandMenu(), 'edit-changelist') as { shortcut?: string }).shortcut,
    undefined,
    'F2 is a key the LIST owns, so the band menu carries no hint for it',
  )

  // The untracked group is not a list: nothing that renames or deletes one.
  assert.deepEqual(
    ids(bandMenu({ kind: 'untracked', changelistId: undefined })),
    ['stage-all', 'unstage-all', 'discard-all', 'after-group-repo', 'refresh'],
    'an untracked group has no changelist to act on, and offers no move, commit or filtered diff',
  )

  // An empty group's "all" actions are unavailable — there is nothing to stage,
  // and `groupToggleAction` would hand the panel an empty path list.
  for (const id of ['stage-all', 'unstage-all', 'discard-all']) {
    assert.equal(
      (find(bandMenu({ totalCount: 0, rows: [], allRows: [] }), id) as { disabled?: boolean }).disabled,
      true,
      `${id} on an empty group would act on nothing`,
    )
  }
}

// ── a guest row's menu withholds what would take another list's lines ────────
//
// A `partial` row is one changelist's view of hunks in a file that lives in
// another list. Discard and Delete are whole-FILE operations, so on that row
// they are disabled and say why in the label — a disabled control receives no
// pointer events, so the reason cannot live in a tooltip.
{
  const guest = rowMenu({ partialOnly: true })
  for (const id of ['discard', 'delete-files']) {
    const item = find(guest, id) as { disabled?: boolean; label: string; shortcut?: string; danger?: boolean }
    assert.equal(item.disabled, true, `${id} would take lines this list does not own`)
    assert.match(item.label, new RegExp(PARTIAL_ROW_REASON), `${id} says where the action lives instead`)
    assert.equal(item.shortcut, undefined, 'and drops the hint for a key that would do nothing here')
    assert.equal(item.danger, false, 'an unavailable item is not coloured as a destructive one')
  }
  // The menu keeps its SHAPE: same items, same order, on a guest row.
  assert.deepEqual(ids(guest), ids(rowMenu()), 'nothing appears or vanishes, only its availability moves')
  // And the ordinary row keeps both.
  assert.equal((find(rowMenu(), 'discard') as { disabled?: boolean }).disabled, false)
  assert.equal((find(rowMenu(), 'delete-files') as { shortcut?: string }).shortcut, '⌫')
}

console.log('ok - the row menu and the band menu keep their shape, their hints and their conditions')
