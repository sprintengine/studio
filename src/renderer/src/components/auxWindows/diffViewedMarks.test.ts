import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { DiffFileItem } from './diffFileList'
import {
  countViewed,
  diffViewedKey,
  fingerprintDiffContent,
  isDiffViewed,
  MAX_VIEWED_MARKS,
  nextUnviewedIndex,
  pruneViewedMarks,
  readViewedMarks,
  withViewedMark,
  writeViewedMarks,
} from './diffViewedMarks'

// Ticking files off as viewed in the diff viewer: a mark is the file as it was
// read, so a file that changes again is unread again.

const file = (relativePath: string, kind: DiffFileItem['kind'] = 'unstaged'): DiffFileItem => ({
  path: `/Users/dev/acme/${relativePath}`,
  relativePath,
  status: 'modified',
  kind,
})

const ready = (original: string, modified: string) => ({ state: 'ready' as const, original, modified })

test('a file’s staged and unstaged diffs are marked apart, and a commit step’s per pair of revisions', () => {
  assert.notEqual(diffViewedKey(file('src/a.ts', 'staged')), diffViewedKey(file('src/a.ts', 'unstaged')))
  const step = { ...file('src/a.ts', 'branch'), originalRev: 'abc', modifiedRev: 'def' }
  assert.equal(diffViewedKey(step), 'branch:abc..def:src/a.ts')
  assert.equal(diffViewedKey(file('src\\a.ts')), 'unstaged:src/a.ts')
})

test('the fingerprint moves when either side does, and is absent while nothing can be read', () => {
  const base = fingerprintDiffContent(ready('one', 'two'))
  assert.ok(base)
  assert.equal(fingerprintDiffContent(ready('one', 'two')), base)
  assert.notEqual(fingerprintDiffContent(ready('one', 'two!')), base)
  assert.notEqual(fingerprintDiffContent(ready('one!', 'two')), base)
  assert.equal(fingerprintDiffContent({ state: 'binary' }), 'binary')
  assert.equal(fingerprintDiffContent({ state: 'loading' }), null)
  assert.equal(fingerprintDiffContent({ state: 'error' }), null)
})

test('a mark holds for the diff that was read, and not once the file changes', () => {
  const item = file('src/a.ts')
  const read = fingerprintDiffContent(ready('a', 'b'))
  const marks = withViewedMark({}, item, read, true)
  assert.equal(isDiffViewed(marks, item, read), true)
  assert.equal(isDiffViewed(marks, item, fingerprintDiffContent(ready('a', 'c'))), false)
  assert.equal(isDiffViewed(withViewedMark(marks, item, read, false), item, read), false)
})

test('marking an unreadable diff does nothing', () => {
  assert.deepEqual(withViewedMark({}, file('src/a.ts'), null, true), {})
})

test('the count is of the listed files that carry a mark', () => {
  const items = [file('a.ts'), file('b.ts'), file('c.ts')]
  let marks = withViewedMark({}, items[0]!, 'x', true)
  marks = withViewedMark(marks, file('gone.ts'), 'y', true)
  assert.equal(countViewed(marks, items), 1)
})

test('a file no longer changed loses its mark when the whole list is known', () => {
  const items = [file('a.ts')]
  const marks = withViewedMark(withViewedMark({}, items[0]!, 'x', true), file('gone.ts'), 'y', true)
  assert.deepEqual(Object.keys(pruneViewedMarks(marks, items)), ['unstaged:a.ts'])
  const unchanged = withViewedMark({}, items[0]!, 'x', true)
  assert.equal(pruneViewedMarks(unchanged, items), unchanged, 'nothing to drop keeps the same object')
})

test('the next file to read skips the ones already viewed, wrapping round, and there is none once all are', () => {
  const items = [file('a.ts'), file('b.ts'), file('c.ts')]
  let marks = withViewedMark({}, items[1]!, 'x', true)
  assert.equal(nextUnviewedIndex(marks, items, 0), 2)
  assert.equal(nextUnviewedIndex(marks, items, 2), 0)
  marks = withViewedMark(withViewedMark(marks, items[0]!, 'x', true), items[2]!, 'x', true)
  assert.equal(nextUnviewedIndex(marks, items, 0), -1)
})

test('marks are kept per repository, and a store that cannot be read holds none', () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
  writeViewedMarks('/Users/dev/acme', { 'unstaged:a.ts': 'x' }, storage)
  assert.deepEqual(readViewedMarks('/Users/dev/acme', storage), { 'unstaged:a.ts': 'x' })
  assert.deepEqual(readViewedMarks('/Users/dev/other', storage), {})
  store.set('sprintengine.diffViewed.v1:/Users/dev/broken', 'not json')
  assert.deepEqual(readViewedMarks('/Users/dev/broken', storage), {})
  writeViewedMarks('/Users/dev/acme', {}, storage)
  assert.equal(store.size, 1, 'an empty set of marks leaves nothing behind')
})

test('past the cap the oldest mark goes, and a file marked again counts as the newest', () => {
  let marks = {}
  for (let index = 0; index < MAX_VIEWED_MARKS; index++) marks = withViewedMark(marks, file(`f${index}.ts`), 'x', true)
  marks = withViewedMark(marks, file('f0.ts'), 'y', true)
  marks = withViewedMark(marks, file('new.ts'), 'x', true)
  const keys = Object.keys(marks)
  assert.equal(keys.length, MAX_VIEWED_MARKS)
  assert.ok(!keys.includes('unstaged:f1.ts'), 'the oldest went')
  assert.ok(keys.includes('unstaged:f0.ts'), 'the one marked again stayed')
  assert.equal(keys.at(-1), 'unstaged:new.ts')
})
