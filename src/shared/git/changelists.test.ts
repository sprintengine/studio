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
  changelistOwnerId,
  createChangelist,
  createDefaultChangelists,
  createOwnedChangelist,
  deleteChangelist,
  hunkOwnerId,
  isPartialInList,
  moveChangelistPaths,
  normalizeChangelists,
  orderedChangelists,
  pathsOfChangelist,
  recordEdit,
  reconcileChangelists,
  renameChangelist,
  setActiveChangelist,
  type Changelist,
  type ChangelistOwner,
  type Edit,
  type OwnedSpan,
} from './changelists'
import { test } from 'vitest'

test('changelists', async () => {
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
    assert.deepEqual(
      moved.filter((list) => list.active).map((list) => list.id),
      ['a'],
    )
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
    assert.deepEqual(
      clean.flatMap((list) => list.paths),
      [],
    )
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
    assert.equal(
      renamed.find((list) => list.id === 'a')?.comment,
      undefined,
      'an emptied comment is dropped, not stored blank',
    )
    assert.equal(
      renameChangelist(renamed, 'a', { name: '   ' }).find((list) => list.id === 'a')?.name,
      'Skills catalogue paging',
    )

    // The default is renameable — the id, not the name, is what paths key to.
    const renamedDefault = renameChangelist(renamed, DEFAULT_CHANGELIST_ID, { name: 'Everything else' })
    assert.equal(renamedDefault[0].id, DEFAULT_CHANGELIST_ID)
    assert.equal(renamedDefault[0].name, 'Everything else')

    // A duplicate id is refused rather than shadowing the list that holds paths.
    assert.deepEqual(createChangelist(renamedDefault, { id: 'a', name: 'Another A' }), renamedDefault)
    assert.deepEqual(createChangelist(renamedDefault, { id: '   ', name: 'Nameless' }), renamedDefault)
  }

  // =============================================================================
  // Agent ownership: spans, the line tracker, and who owns a hunk.
  //
  // Same discipline as above — every block is one of the three new rules stated
  // in the module header, written as the way it would break. The file the spans
  // are written against is imaginary but consistent: line numbers are git's, and
  // a zero-length span is a deletion anchored after a line, never a line.
  // =============================================================================

  const FILE = 'src/app.ts'
  const NADIA: ChangelistOwner = { kind: 'agent', agentId: 'nadia', name: 'Nadia' }
  const RAVI: ChangelistOwner = { kind: 'agent', agentId: 'ravi', name: 'Ravi' }
  const NADIA_ID = changelistOwnerId('nadia')
  const RAVI_ID = changelistOwnerId('ravi')

  function spansIn(lists: Changelist[], id: string, path = FILE): OwnedSpan[] {
    return lists.find((list) => list.id === id)?.spans?.[path] ?? []
  }

  /** Two agents with lists of their own, and a file whose HOME is the default. */
  function seeded(): Changelist[] {
    let lists = createOwnedChangelist(createDefaultChangelists(), NADIA)
    lists = createOwnedChangelist(lists, RAVI)
    return moveChangelistPaths(lists, DEFAULT_CHANGELIST_ID, [FILE])
  }

  // --- An agent's list is made once, however many times it is asked for --------
  {
    const once = createOwnedChangelist(createDefaultChangelists(), NADIA)
    assert.deepEqual(ids(once), [DEFAULT_CHANGELIST_ID, NADIA_ID])
    assert.equal(once[1].name, 'Nadia')
    assert.deepEqual(once[1].owner, NADIA)
    assert.equal(activeChangelist(once)?.id, DEFAULT_CHANGELIST_ID, 'creating is not activating')

    const twice = createOwnedChangelist(once, NADIA)
    assert.deepEqual(twice, once, 'the second launch of one agent adds nothing and moves nothing')

    const withWork = moveChangelistPaths(once, NADIA_ID, ['src/a.ts'])
    const renamedAgent = createOwnedChangelist(withWork, { ...NADIA, name: 'Nadia (2)' })
    assert.equal(renamedAgent.find((list) => list.id === NADIA_ID)?.name, 'Nadia (2)')
    assert.deepEqual(pathsOf(renamedAgent, NADIA_ID), ['src/a.ts'], 'a rename keeps the list it renames')

    // A relaunch clears the tombstone the store set when the agent exited.
    const exited = createOwnedChangelist(withWork, { ...NADIA, exited: true })
    assert.equal(exited.find((list) => list.id === NADIA_ID)?.owner?.exited, true)
    const relaunched = createOwnedChangelist(exited, NADIA)
    assert.equal(relaunched.find((list) => list.id === NADIA_ID)?.owner?.exited, undefined)

    const activated = createOwnedChangelist(once, RAVI, { activate: true })
    assert.equal(activeChangelist(activated)?.id, RAVI_ID)
    assert.equal(changelistOwnerId(' nadia '), NADIA_ID)

    // A list with an owner survives a rename and a normalize round trip.
    const kept = renameChangelist(activated, RAVI_ID, { name: 'Ravi the second' })
    assert.deepEqual(kept.find((list) => list.id === RAVI_ID)?.owner, RAVI)
  }

  // --- First claim: an unowned file becomes the editor's, whole ----------------
  {
    const lists = createOwnedChangelist(createDefaultChangelists(), NADIA)
    const claimed = recordEdit(lists, NADIA_ID, FILE, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 4 }])
    assert.deepEqual(pathsOf(claimed, NADIA_ID), [FILE], 'a file with no home joins the editor')
    assert.equal(
      claimed.find((list) => list.id === NADIA_ID)?.spans,
      undefined,
      'the home list never spans its own file',
    )

    // A frame the reporter could not read (no edits) still claims an unowned file
    // — file-level ownership is the fallback, not nothing.
    const fileLevel = recordEdit(lists, NADIA_ID, 'src/new.ts', [])
    assert.deepEqual(pathsOf(fileLevel, NADIA_ID), ['src/new.ts'])
    assert.deepEqual(recordEdit(claimed, NADIA_ID, FILE, []), claimed, 'and leaves a file that has a home alone')

    assert.deepEqual(
      recordEdit(claimed, 'agent:ghost', FILE, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }]),
      claimed,
      'an editor with no list changes nothing rather than inventing one',
    )
    assert.deepEqual(recordEdit(claimed, NADIA_ID, '   ', []), claimed)
  }

  // --- Two agents in one file: the latest editor owns the lines it wrote -------
  {
    const base = seeded()

    // Nadia replaces lines 5-6 with four lines. She is a guest, so she gets a span.
    const first = recordEdit(base, NADIA_ID, FILE, [{ oldStart: 5, oldLines: 2, newStart: 5, newLines: 4 }])
    assert.deepEqual(spansIn(first, NADIA_ID), [{ start: 5, lines: 4 }])
    assert.deepEqual(pathsOf(first, NADIA_ID), [], 'a span is not membership; the file still lives in Changes')

    // Ravi inserts two lines ABOVE her, and her span slides down with the file.
    const second = recordEdit(first, RAVI_ID, FILE, [{ oldStart: 3, oldLines: 0, newStart: 4, newLines: 2 }])
    assert.deepEqual(spansIn(second, NADIA_ID), [{ start: 7, lines: 4 }], 'an edit above a span moves it')
    assert.deepEqual(spansIn(second, RAVI_ID), [{ start: 4, lines: 2 }])

    // Nadia edits inside her own run: the pieces on either side and the new
    // region are one run again, not three.
    const third = recordEdit(second, NADIA_ID, FILE, [{ oldStart: 8, oldLines: 2, newStart: 8, newLines: 1 }])
    assert.deepEqual(spansIn(third, NADIA_ID), [{ start: 7, lines: 3 }], 'touching runs in ONE list coalesce')
    assert.deepEqual(spansIn(third, RAVI_ID), [{ start: 4, lines: 2 }], 'and a run below the edit is untouched')

    // The home list edits over Nadia's lines 7-8 and takes them back — by the
    // remainder rule, not by writing a span of its own.
    const fourth = recordEdit(third, DEFAULT_CHANGELIST_ID, FILE, [
      { oldStart: 7, oldLines: 2, newStart: 7, newLines: 2 },
    ])
    assert.deepEqual(
      spansIn(fourth, NADIA_ID),
      [{ start: 9, lines: 1 }],
      'the home edit cuts the guest span it overwrote',
    )
    assert.equal(fourth[0].spans, undefined, 'and the home writes no span for its own file')
    assert.equal(hunkOwnerId(fourth, FILE, { newStart: 7, newLines: 2 }), DEFAULT_CHANGELIST_ID)

    // Adjacent runs in TWO lists stay two runs: merging them would merge authors.
    const adjacent = normalizeChangelists([
      { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [FILE], active: true },
      { id: NADIA_ID, name: 'Nadia', paths: [], active: false, spans: { [FILE]: [{ start: 5, lines: 2 }] } },
      { id: RAVI_ID, name: 'Ravi', paths: [], active: false, spans: { [FILE]: [{ start: 7, lines: 3 }] } },
    ])
    assert.deepEqual(spansIn(adjacent, NADIA_ID), [{ start: 5, lines: 2 }])
    assert.deepEqual(spansIn(adjacent, RAVI_ID), [{ start: 7, lines: 3 }])
  }

  // --- A guest run that straddles the edited region survives on both sides -----
  {
    const base = recordEdit(seeded(), NADIA_ID, FILE, [{ oldStart: 5, oldLines: 6, newStart: 5, newLines: 6 }])
    assert.deepEqual(spansIn(base, NADIA_ID), [{ start: 5, lines: 6 }])

    // Ravi replaces lines 7-8 (the middle of it) with one line.
    const split = recordEdit(base, RAVI_ID, FILE, [{ oldStart: 7, oldLines: 2, newStart: 7, newLines: 1 }])
    assert.deepEqual(
      spansIn(split, NADIA_ID),
      [
        { start: 5, lines: 2 },
        { start: 8, lines: 2 },
      ],
      'the head keeps its place and the tail shifts by the length the edit changed',
    )
    assert.deepEqual(spansIn(split, RAVI_ID), [{ start: 7, lines: 1 }])
  }

  // --- Deletions: a span of no lines, anchored after one -----------------------
  {
    const base = seeded()

    // git spells "deleted old lines 2-3" as `+1,0` — after new line 1.
    const deleted = recordEdit(base, NADIA_ID, FILE, [{ oldStart: 2, oldLines: 2, newStart: 1, newLines: 0 }])
    assert.deepEqual(spansIn(deleted, NADIA_ID), [{ start: 1, lines: 0 }])
    assert.equal(hunkOwnerId(deleted, FILE, { newStart: 1, newLines: 0 }), NADIA_ID)
    assert.equal(hunkOwnerId(deleted, FILE, { newStart: 2, newLines: 0 }), DEFAULT_CHANGELIST_ID)

    // A deletion at the very head of the file is `+0,0`, and start 0 is the one
    // place a span may sit there. Dropping it would hand every head-of-file
    // deletion back to the home list.
    const head = recordEdit(base, NADIA_ID, FILE, [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }])
    assert.deepEqual(spansIn(head, NADIA_ID), [{ start: 0, lines: 0 }])
    assert.deepEqual(normalizeChangelists(head), head, 'and normalize keeps it')

    // An anchor rides the file: three lines inserted at its head (git's `-0,0`)
    // push it down with everything else.
    const above = recordEdit(deleted, RAVI_ID, FILE, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }])
    assert.deepEqual(spansIn(above, NADIA_ID), [{ start: 4, lines: 0 }])
    assert.deepEqual(spansIn(above, RAVI_ID), [{ start: 1, lines: 3 }])

    // An insertion into the very gap the anchor names leaves it where it is —
    // the deletion still happened after that line.
    const beside = recordEdit(deleted, RAVI_ID, FILE, [{ oldStart: 1, oldLines: 0, newStart: 2, newLines: 3 }])
    assert.deepEqual(spansIn(beside, NADIA_ID), [{ start: 1, lines: 0 }])

    // And it dies with the line it hangs off.
    const overwritten = recordEdit(above, DEFAULT_CHANGELIST_ID, FILE, [
      { oldStart: 4, oldLines: 2, newStart: 4, newLines: 1 },
    ])
    assert.deepEqual(spansIn(overwritten, NADIA_ID), [], 'the anchor goes when its line does')

    // The boundaries of a deleted region: the anchor just above it keeps its
    // place, the one hanging off its last line goes with that line, and the one
    // below rides up. Off by one here and a deletion marker lands in the wrong
    // group for the rest of the file's life.
    const anchored = normalizeChangelists([
      { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [FILE], active: true },
      {
        id: NADIA_ID,
        name: 'Nadia',
        paths: [],
        active: false,
        spans: {
          [FILE]: [
            { start: 3, lines: 0 },
            { start: 5, lines: 0 },
            { start: 8, lines: 0 },
          ],
        },
      },
    ])
    const cutAround = recordEdit(anchored, DEFAULT_CHANGELIST_ID, FILE, [
      { oldStart: 4, oldLines: 3, newStart: 3, newLines: 0 },
    ])
    assert.deepEqual(spansIn(cutAround, NADIA_ID), [
      { start: 3, lines: 0 },
      { start: 5, lines: 0 },
    ])

    // Two lists cannot hold the same deletion point either.
    const twice = normalizeChangelists([
      { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [FILE], active: true },
      { id: NADIA_ID, name: 'Nadia', paths: [], active: false, spans: { [FILE]: [{ start: 4, lines: 0 }] } },
      { id: RAVI_ID, name: 'Ravi', paths: [], active: false, spans: { [FILE]: [{ start: 4, lines: 0 }] } },
    ])
    assert.deepEqual(spansIn(twice, NADIA_ID), [{ start: 4, lines: 0 }])
    assert.deepEqual(spansIn(twice, RAVI_ID), [])
    assert.deepEqual(normalizeChangelists(twice), twice)

    // An anchor inside a run of the same list is redundant — the run already owns
    // the line it hangs off, and `hunkOwnerId` finds it there.
    const swallowed = normalizeChangelists([
      { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [FILE], active: true },
      {
        id: NADIA_ID,
        name: 'Nadia',
        paths: [],
        active: false,
        spans: {
          [FILE]: [
            { start: 10, lines: 3 },
            { start: 11, lines: 0 },
            { start: 13, lines: 0 },
          ],
        },
      },
    ])
    assert.deepEqual(spansIn(swallowed, NADIA_ID), [
      { start: 10, lines: 3 },
      { start: 13, lines: 0 },
    ])
    assert.equal(hunkOwnerId(swallowed, FILE, { newStart: 11, newLines: 0 }), NADIA_ID)
  }

  // --- Many edits in one call: ascending with an offset === descending, one by one
  {
    // One tool call against a 20-line file: a replacement, an insertion and a
    // deletion, every `old*` in the coordinates the file had BEFORE the call.
    const call: Edit[] = [
      { oldStart: 3, oldLines: 2, newStart: 3, newLines: 1 },
      { oldStart: 10, oldLines: 0, newStart: 10, newLines: 3 },
      { oldStart: 15, oldLines: 2, newStart: 16, newLines: 0 },
    ]
    const base = seeded()

    const ascending = recordEdit(base, NADIA_ID, FILE, call)
    assert.deepEqual(spansIn(ascending, NADIA_ID), [
      { start: 3, lines: 1 },
      { start: 10, lines: 3 },
      { start: 16, lines: 0 },
    ])
    assert.deepEqual(
      spansIn(ascending, NADIA_ID).map((span) => span.start),
      call.map((edit) => edit.newStart),
      'the position the tracker derives is the one git wrote in `newStart`',
    )

    // The other way to write this function: apply the edits one at a time from
    // the bottom of the file up, where no offset is needed because nothing below
    // an edit has moved yet. The two must land in the same place.
    let descending = base
    for (const edit of [...call].reverse()) descending = recordEdit(descending, NADIA_ID, FILE, [edit])
    assert.deepEqual(descending, ascending, 'ascending-with-offset and descending-one-at-a-time agree')

    // Handed the edits out of order, the tracker sorts them rather than reading
    // the second one's coordinates against a file the first already moved.
    assert.deepEqual(recordEdit(base, NADIA_ID, FILE, [...call].reverse()), ascending)

    // Nonsense in one edit is dropped without losing the rest of the call.
    const noisy = recordEdit(base, NADIA_ID, FILE, [
      ...call,
      { oldStart: -4, oldLines: 1, newStart: 4, newLines: 1 },
      { oldStart: 2.5, oldLines: 1, newStart: 2, newLines: 1 } as Edit,
    ])
    assert.deepEqual(spansIn(noisy, NADIA_ID), spansIn(ascending, NADIA_ID))
  }

  // --- Who owns a hunk: majority, then order; otherwise the home ---------------
  {
    const lists = normalizeChangelists([
      { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [FILE], active: true },
      {
        id: NADIA_ID,
        name: 'Nadia',
        paths: [],
        active: false,
        spans: {
          [FILE]: [
            { start: 10, lines: 3 },
            { start: 30, lines: 2 },
          ],
        },
      },
      {
        id: RAVI_ID,
        name: 'Ravi',
        paths: [],
        active: false,
        spans: {
          [FILE]: [
            { start: 13, lines: 1 },
            { start: 32, lines: 2 },
          ],
        },
      },
    ])

    assert.equal(hunkOwnerId(lists, FILE, { newStart: 10, newLines: 5 }), NADIA_ID, 'three lines beat one')
    assert.equal(hunkOwnerId(lists, FILE, { newStart: 13, newLines: 2 }), RAVI_ID, 'and one line beats none')
    assert.equal(
      hunkOwnerId(lists, FILE, { newStart: 30, newLines: 4 }),
      NADIA_ID,
      'a tie goes to the list earlier in the array, so the row does not flicker between two groups',
    )
    assert.equal(
      hunkOwnerId(lists, FILE, { newStart: 50, newLines: 2 }),
      DEFAULT_CHANGELIST_ID,
      'the remainder is the home list',
    )
    assert.equal(hunkOwnerId(lists, 'src/other.ts', { newStart: 1, newLines: 9 }), DEFAULT_CHANGELIST_ID)
    assert.equal(
      hunkOwnerId(lists, FILE, { newStart: 11, newLines: 0 }),
      NADIA_ID,
      'a deletion inside a run belongs to that run',
    )

    // A whole line always beats a deletion point, whatever the count.
    const mixed = normalizeChangelists([
      { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [FILE], active: true },
      { id: NADIA_ID, name: 'Nadia', paths: [], active: false, spans: { [FILE]: [{ start: 5, lines: 1 }] } },
      {
        id: RAVI_ID,
        name: 'Ravi',
        paths: [],
        active: false,
        spans: {
          [FILE]: [
            { start: 6, lines: 0 },
            { start: 7, lines: 0 },
          ],
        },
      },
    ])
    assert.equal(hunkOwnerId(mixed, FILE, { newStart: 5, newLines: 4 }), NADIA_ID)
    assert.equal(hunkOwnerId(mixed, FILE, { newStart: 6, newLines: 0 }), RAVI_ID)
  }

  // --- A span is a guest: no home, or its own home, and it is not a span -------
  {
    const repaired = normalizeChangelists([
      {
        id: DEFAULT_CHANGELIST_ID,
        name: 'Changes',
        paths: [FILE],
        active: true,
        spans: { [FILE]: [{ start: 1, lines: 2 }] },
      },
      {
        id: NADIA_ID,
        name: 'Nadia',
        paths: ['src/mine.ts'],
        active: false,
        spans: {
          [FILE]: [{ start: 4, lines: 2 }],
          'src/mine.ts': [{ start: 1, lines: 1 }],
          'src/nobody.ts': [{ start: 1, lines: 1 }],
          'src\\app.ts': [{ start: 8, lines: 1 }],
          'src/junk.ts': [{ start: 0, lines: 3 }, { start: 2, lines: -1 }, { start: 1.5, lines: 1 }, 'nope'],
          'src/empty.ts': [],
        },
      },
    ])
    assert.equal(repaired[0].spans, undefined, 'a list does not span its own file')
    assert.deepEqual(Object.keys(repaired[1].spans ?? {}), [FILE], 'no home, own home, and malformed all go')
    assert.deepEqual(
      spansIn(repaired, NADIA_ID),
      [
        { start: 4, lines: 2 },
        { start: 8, lines: 1 },
      ],
      'and two spellings are one path',
    )

    // Two lists cannot own one line: the earlier list keeps it, exactly as it
    // does for whole-file membership.
    const overlapping = normalizeChangelists([
      { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [FILE], active: true },
      { id: NADIA_ID, name: 'Nadia', paths: [], active: false, spans: { [FILE]: [{ start: 5, lines: 4 }] } },
      {
        id: RAVI_ID,
        name: 'Ravi',
        paths: [],
        active: false,
        spans: {
          [FILE]: [
            { start: 6, lines: 4 },
            { start: 6, lines: 0 },
          ],
        },
      },
    ])
    assert.deepEqual(spansIn(overlapping, NADIA_ID), [{ start: 5, lines: 4 }])
    assert.deepEqual(spansIn(overlapping, RAVI_ID), [{ start: 9, lines: 1 }])

    // Normalize is a fixed point: the store writes what it read back, and the
    // renderer normalizes again on every render.
    assert.deepEqual(normalizeChangelists(repaired), repaired)
    assert.deepEqual(normalizeChangelists(overlapping), overlapping)
    assert.deepEqual(normalizeChangelists(normalizeChangelists(overlapping)), overlapping)
  }

  // --- The rows a list draws ---------------------------------------------------
  {
    const lists = recordEdit(moveChangelistPaths(seeded(), NADIA_ID, ['src/mine.ts']), NADIA_ID, FILE, [
      { oldStart: 5, oldLines: 1, newStart: 5, newLines: 2 },
    ])
    const nadia = lists.find((list) => list.id === NADIA_ID) as Changelist
    assert.deepEqual(pathsOfChangelist(nadia), [FILE, 'src/mine.ts'], 'a list draws its whole files and its pieces')
    assert.equal(isPartialInList(nadia, FILE), true)
    assert.equal(isPartialInList(nadia, 'src\\app.ts'), true, 'and the path spelling does not decide it')
    assert.equal(isPartialInList(nadia, 'src/mine.ts'), false, 'a file it owns whole is not a partial row')
    assert.deepEqual(pathsOfChangelist(lists[0]), [FILE], 'the home list still draws the file whole')
  }

  // --- A hand move is a file-level decision; a delete takes its spans with it --
  {
    const base = recordEdit(seeded(), NADIA_ID, FILE, [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 2 }])
    assert.deepEqual(spansIn(base, NADIA_ID), [{ start: 5, lines: 2 }])

    const moved = moveChangelistPaths(base, RAVI_ID, [FILE])
    assert.deepEqual(pathsOf(moved, RAVI_ID), [FILE])
    assert.deepEqual(spansIn(moved, NADIA_ID), [], 'dragging the file into a list clears every other list’s spans')

    // Deleting the list that held the spans gives those lines back to the home.
    const deleted = deleteChangelist(base, NADIA_ID)
    assert.deepEqual(ids(deleted), [DEFAULT_CHANGELIST_ID, RAVI_ID])
    assert.deepEqual(spansIn(deleted, DEFAULT_CHANGELIST_ID), [])
    assert.equal(hunkOwnerId(deleted, FILE, { newStart: 5, newLines: 2 }), DEFAULT_CHANGELIST_ID)

    // Deleting the HOME moves the home to the default, and a span the default was
    // holding on that file becomes a span on its own file — dropped, not kept.
    const guestIsDefault = recordEdit(moveChangelistPaths(seeded(), NADIA_ID, [FILE]), DEFAULT_CHANGELIST_ID, FILE, [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ])
    assert.deepEqual(spansIn(guestIsDefault, DEFAULT_CHANGELIST_ID), [{ start: 2, lines: 1 }])
    const homeGone = deleteChangelist(guestIsDefault, NADIA_ID)
    assert.deepEqual(pathsOf(homeGone, DEFAULT_CHANGELIST_ID), [FILE])
    assert.equal(homeGone[0].spans, undefined, 'the file came home, so the span it held there is meaningless')
  }

  // --- Reconcile: spans follow the diff, and a spent agent list is swept up ----
  {
    const base = recordEdit(seeded(), NADIA_ID, FILE, [{ oldStart: 5, oldLines: 2, newStart: 5, newLines: 3 }])

    // No hunk map (every caller before agent changelists): spans are left alone.
    assert.deepEqual(spansIn(reconcileChangelists(base, [FILE]), NADIA_ID), [{ start: 5, lines: 3 }])

    // The file was committed: its home is pruned, so the guest span has nothing
    // to be a guest in.
    assert.deepEqual(spansIn(reconcileChangelists(base, []), NADIA_ID), [])

    // The hunks moved on — Nadia's lines are no longer part of any difference.
    const stale = reconcileChangelists(base, [FILE], { [FILE]: [{ newStart: 40, newLines: 2 }] })
    assert.deepEqual(spansIn(stale, NADIA_ID), [])
    assert.equal(
      stale.find((list) => list.id === NADIA_ID)?.spans,
      undefined,
      'and the empty record is dropped, not left as {}',
    )

    const live = reconcileChangelists(base, [FILE], { [FILE]: [{ newStart: 6, newLines: 1 }] })
    assert.deepEqual(spansIn(live, NADIA_ID), [{ start: 5, lines: 3 }], 'a span that overlaps a hunk stays whole')

    // A path the caller did not look up is not a path with no hunks.
    const unlooked = reconcileChangelists(base, [FILE], {})
    assert.deepEqual(spansIn(unlooked, NADIA_ID), [{ start: 5, lines: 3 }])
    assert.deepEqual(spansIn(reconcileChangelists(base, [FILE], { [FILE]: [] }), NADIA_ID), [])

    // An agent that exited and holds nothing is deleted; one that still holds
    // something is not.
    const exited = base.map((list) => (list.id === NADIA_ID ? { ...list, owner: { ...NADIA, exited: true } } : list))
    assert.deepEqual(
      ids(reconcileChangelists(exited, [FILE])),
      [DEFAULT_CHANGELIST_ID, NADIA_ID, RAVI_ID],
      'it still owns hunks',
    )
    assert.deepEqual(
      ids(reconcileChangelists(exited, [FILE], { [FILE]: [{ newStart: 40, newLines: 2 }] })),
      [DEFAULT_CHANGELIST_ID, RAVI_ID],
      'committed, exited and empty: the group would be a permanent empty header',
    )
    const exitedWithFile = moveChangelistPaths(exited, NADIA_ID, ['src/mine.ts'])
    assert.deepEqual(
      ids(reconcileChangelists(exitedWithFile, ['src/mine.ts'])),
      [DEFAULT_CHANGELIST_ID, NADIA_ID, RAVI_ID],
      'a list with work in it outlives its agent',
    )

    // The active flag cannot be deleted along with the list that held it.
    const activeExited = setActiveChangelist(exited, NADIA_ID)
    const swept = reconcileChangelists(activeExited, [FILE], { [FILE]: [{ newStart: 40, newLines: 2 }] })
    assert.equal(activeChangelist(swept)?.id, DEFAULT_CHANGELIST_ID)
    assert.equal(swept.filter((list) => list.active).length, 1)

    // An active AGENT list adopts visible new work and not the dotfiles the app
    // wrote into the workspace when the agent launched; a hand-made active list
    // adopts everything, as T6 always did.
    const nadiaActive = setActiveChangelist(createOwnedChangelist(createDefaultChangelists(), NADIA), NADIA_ID)
    const scaffolded = reconcileChangelists(nadiaActive, [
      'src/new.ts',
      '.claude/settings.local.json',
      '.multicode/hooks/agent-state.mjs',
      'docs/.hidden/note.md',
    ])
    assert.deepEqual(pathsOf(scaffolded, NADIA_ID), ['src/new.ts'])
    assert.deepEqual(pathsOf(scaffolded, DEFAULT_CHANGELIST_ID), [
      '.claude/settings.local.json',
      '.multicode/hooks/agent-state.mjs',
      'docs/.hidden/note.md',
    ])
    const featureActive = setActiveChangelist(
      createChangelist(createDefaultChangelists(), { id: 'feature', name: 'Feature' }),
      'feature',
    )
    assert.deepEqual(
      pathsOf(reconcileChangelists(featureActive, ['src/new.ts', '.claude/settings.local.json']), 'feature'),
      ['.claude/settings.local.json', 'src/new.ts'],
    )
    // The hook's explicit claim still puts a hidden file the agent edited in its list.
    const claimed = recordEdit(nadiaActive, NADIA_ID, '.github/workflows/ci.yml', [])
    assert.deepEqual(pathsOf(reconcileChangelists(claimed, ['.github/workflows/ci.yml']), NADIA_ID), [
      '.github/workflows/ci.yml',
    ])
  }

  console.log('changelists model ok')
})
