/**
 * The changelist model (epic `git-commit-window`, T6). Every assertion here is
 * one of the four rules the module's header states, and each is written as the
 * RACE that would break it rather than as a happy path — two lists both active,
 * a path in two lists after a move, the default deleted, a stale count.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_CHANGELIST_ID,
  activeChangelist,
  changelistIdForPath,
  createChangelist,
  createDefaultChangelists,
  deleteChangelist,
  moveChangelistPaths,
  normalizeChangelists,
  orderedChangelists,
  reconcileChangelists,
  renameChangelist,
  setActiveChangelist,
  type Changelist,
} from './changelists'

function ids(lists: Changelist[]): string[] {
  return lists.map((list) => list.id)
}

function pathsOf(lists: Changelist[], id: string): string[] {
  return lists.find((list) => list.id === id)?.paths ?? []
}

// --- The default exists, always, first ---------------------------------------
{
  const fresh = createDefaultChangelists()
  assert.deepEqual(ids(fresh), [DEFAULT_CHANGELIST_ID])
  assert.equal(fresh[0].name, 'Changes')
  assert.equal(fresh[0].active, true)

  // A store file that never mentioned the default still opens with one.
  const repaired = normalizeChangelists([{ id: 'feature', name: 'Feature', paths: ['a.ts'], active: true }])
  assert.deepEqual(ids(repaired), [DEFAULT_CHANGELIST_ID, 'feature'])
  assert.equal(activeChangelist(repaired)?.id, 'feature')

  // And garbage is repaired rather than thrown: nothing about a corrupt file
  // should be able to keep the panel from rendering.
  assert.deepEqual(ids(normalizeChangelists(null)), [DEFAULT_CHANGELIST_ID])
  assert.deepEqual(ids(normalizeChangelists([{ name: 'no id' }, 42, null])), [DEFAULT_CHANGELIST_ID])
}

// --- Exactly one active, whatever the file said ------------------------------
{
  const two = normalizeChangelists([
    { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [], active: true },
    { id: 'a', name: 'A', paths: [], active: true },
    { id: 'b', name: 'B', paths: [], active: true },
  ])
  assert.deepEqual(
    two.filter((list) => list.active).map((list) => list.id),
    [DEFAULT_CHANGELIST_ID],
    'the first claim wins and every other active flag is cleared',
  )

  const none = normalizeChangelists([
    { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [], active: false },
    { id: 'a', name: 'A', paths: [], active: false },
  ])
  assert.equal(activeChangelist(none)?.id, DEFAULT_CHANGELIST_ID, 'nobody active means the default is')

  // Setting active is exclusive, and naming a list that does not exist is a
  // no-op rather than a state with nothing active.
  const moved = setActiveChangelist(none, 'a')
  assert.deepEqual(moved.filter((list) => list.active).map((list) => list.id), ['a'])
  assert.deepEqual(setActiveChangelist(moved, 'ghost'), moved)
}

// --- A path is in at most one list -------------------------------------------
{
  const overlapping = normalizeChangelists([
    { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: ['src/a.ts'], active: true },
    { id: 'feature', name: 'Feature', paths: ['src/a.ts', 'src/b.ts'], active: false },
  ])
  assert.deepEqual(pathsOf(overlapping, DEFAULT_CHANGELIST_ID), ['src/a.ts'])
  assert.deepEqual(pathsOf(overlapping, 'feature'), ['src/b.ts'], 'the second claim on a path loses')

  // A move takes the path out of the list it was in, in one step — not "adds
  // here, prunes there on the next read".
  const afterMove = moveChangelistPaths(overlapping, 'feature', ['src/a.ts'])
  assert.deepEqual(pathsOf(afterMove, DEFAULT_CHANGELIST_ID), [])
  assert.deepEqual(pathsOf(afterMove, 'feature'), ['src/a.ts', 'src/b.ts'])
  assert.equal(changelistIdForPath(afterMove, 'src/a.ts'), 'feature')
  assert.equal(changelistIdForPath(afterMove, 'src/never-seen.ts'), DEFAULT_CHANGELIST_ID)

  // Windows spellings and `./` prefixes are the same path, so they cannot end
  // up as two rows in two lists.
  const spelled = moveChangelistPaths(afterMove, DEFAULT_CHANGELIST_ID, ['src\\a.ts'])
  assert.deepEqual(pathsOf(spelled, DEFAULT_CHANGELIST_ID), ['src/a.ts'])
  assert.deepEqual(pathsOf(spelled, 'feature'), ['src/b.ts'])
  assert.deepEqual(moveChangelistPaths(spelled, 'ghost', ['src/b.ts']), spelled, 'a missing target moves nothing')
}

// --- The default cannot be deleted; a deleted list returns its paths ---------
{
  const lists = moveChangelistPaths(
    createChangelist(createDefaultChangelists(), { id: 'feature', name: 'Feature', activate: true }),
    'feature',
    ['src/a.ts', 'src/b.ts'],
  )
  assert.equal(activeChangelist(lists)?.id, 'feature')

  assert.deepEqual(deleteChangelist(lists, DEFAULT_CHANGELIST_ID), lists, 'the default survives its own delete')

  const deleted = deleteChangelist(lists, 'feature')
  assert.deepEqual(ids(deleted), [DEFAULT_CHANGELIST_ID])
  assert.deepEqual(pathsOf(deleted, DEFAULT_CHANGELIST_ID), ['src/a.ts', 'src/b.ts'])
  assert.equal(
    activeChangelist(deleted)?.id,
    DEFAULT_CHANGELIST_ID,
    'deleting the active list hands the flag to the default rather than leaving none',
  )
  assert.deepEqual(deleteChangelist(deleted, 'gone'), deleted, 'deleting a missing list changes nothing')
}

// --- New changes land in the active list; vanished ones are pruned -----------
{
  const withFeature = createChangelist(createDefaultChangelists(), {
    id: 'feature',
    name: 'Feature',
    comment: '  Modal header group  ',
    activate: true,
  })
  assert.equal(withFeature.find((list) => list.id === 'feature')?.comment, 'Modal header group')

  const firstRead = reconcileChangelists(withFeature, ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(pathsOf(firstRead, 'feature'), ['src/a.ts', 'src/b.ts'], 'unclaimed changes join the active list')
  assert.deepEqual(pathsOf(firstRead, DEFAULT_CHANGELIST_ID), [])

  // Switching the active list back does NOT drag the files with it: only paths
  // git reports for the first time are adopted.
  const backToDefault = setActiveChangelist(firstRead, DEFAULT_CHANGELIST_ID)
  const secondRead = reconcileChangelists(backToDefault, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  assert.deepEqual(pathsOf(secondRead, 'feature'), ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(pathsOf(secondRead, DEFAULT_CHANGELIST_ID), ['src/c.ts'])

  // b.ts was committed. Its row is gone, and so is the count that included it.
  const thirdRead = reconcileChangelists(secondRead, ['src/a.ts', 'src/c.ts'])
  assert.deepEqual(pathsOf(thirdRead, 'feature'), ['src/a.ts'])
  assert.deepEqual(pathsOf(thirdRead, DEFAULT_CHANGELIST_ID), ['src/c.ts'])

  // A clean tree empties every list without deleting any of them.
  const clean = reconcileChangelists(thirdRead, [])
  assert.deepEqual(ids(clean), [DEFAULT_CHANGELIST_ID, 'feature'])
  assert.deepEqual(clean.flatMap((list) => list.paths), [])
}

// --- Rename, and the order the panel renders ---------------------------------
{
  let lists = createChangelist(createDefaultChangelists(), { id: 'a', name: 'A' })
  lists = createChangelist(lists, { id: 'b', name: 'B', activate: true })
  assert.deepEqual(ids(orderedChangelists(lists)), ['b', 'a', DEFAULT_CHANGELIST_ID], 'active first, default last')

  lists = setActiveChangelist(lists, DEFAULT_CHANGELIST_ID)
  assert.deepEqual(
    ids(orderedChangelists(lists)),
    [DEFAULT_CHANGELIST_ID, 'a', 'b'],
    'the default rides at the head when it is the active one, and is not also listed at the tail',
  )

  const renamed = renameChangelist(lists, 'a', { name: '  Skills catalogue paging  ', comment: '' })
  assert.equal(renamed.find((list) => list.id === 'a')?.name, 'Skills catalogue paging')
  assert.equal(renamed.find((list) => list.id === 'a')?.comment, undefined, 'an emptied comment is dropped, not stored blank')
  assert.equal(renameChangelist(renamed, 'a', { name: '   ' }).find((list) => list.id === 'a')?.name, 'Skills catalogue paging')

  // The default is renameable — the id, not the name, is what paths key to.
  const renamedDefault = renameChangelist(renamed, DEFAULT_CHANGELIST_ID, { name: 'Everything else' })
  assert.equal(renamedDefault[0].id, DEFAULT_CHANGELIST_ID)
  assert.equal(renamedDefault[0].name, 'Everything else')

  // A duplicate id is refused rather than shadowing the list that holds paths.
  assert.deepEqual(createChangelist(renamedDefault, { id: 'a', name: 'Another A' }), renamedDefault)
  assert.deepEqual(createChangelist(renamedDefault, { id: '   ', name: 'Nameless' }), renamedDefault)
}

console.log('changelists model ok')
