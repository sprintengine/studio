import assert from 'node:assert/strict'
import { test } from 'vitest'

import { tourAskText } from './tour-ask'
import { normalizeTourPath, parseTourCreate, parseTourUpdate, TOUR_APPEND } from './tour-input'

test('a well-formed tour parses, with side defaulting to new', () => {
  const parsed = parseTourCreate({
    title: 'Retry',
    changes: { kind: 'changelist' },
    steps: [{ id: 'a', title: 'A', body: 'why', path: './src/a.ts', match: 'x' }],
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.value.steps[0].side, 'new')
  assert.equal(parsed.value.steps[0].path, 'src/a.ts')
})

test('shape problems are all listed, and the well-formed steps survive as a partial', () => {
  const parsed = parseTourCreate({
    title: 'Retry',
    changes: { kind: 'worktree' },
    steps: [
      { id: 'a', title: 'A', body: 'why', path: 'src/a.ts', hunk: 1, lines: [1, 2] },
      { id: 'b', title: 'B', body: 'why', path: '../outside.ts', match: 'x' },
      { title: 'no id', body: 'why', path: 'src/c.ts', fileOnly: true },
      { id: 'ok', title: 'Fine', body: 'why', path: 'src/d.ts', match: 'y' },
      { id: 'ok', title: 'Twin', body: 'why', path: 'src/d.ts', match: 'z' },
    ],
  })
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  const text = parsed.errors.join('\n')
  assert.match(text, /Step 1 \("a"\): give exactly one anchor; this step has lines and hunk/)
  assert.match(text, /Step 2 \("b"\): path "..\/outside.ts" must be relative/)
  assert.match(text, /steps\[2\]: `id` is required/)
  assert.match(text, /Step id "ok" is used more than once/)
  assert.equal(parsed.partial?.steps.map((step) => step.id).join(','), 'ok,ok')
})

test('a range needs both ends, and an unknown kind is named', () => {
  const noHead = parseTourCreate({ title: 't', changes: { kind: 'range', base: 'main' }, steps: [] })
  assert.equal(noHead.ok, false)
  if (!noHead.ok) {
    assert.match(noHead.errors.join('\n'), /range needs both `base` and `head`/)
    assert.match(noHead.errors.join('\n'), /non-empty array of steps/)
    assert.equal(noHead.partial, null, 'no changes, nothing to resolve anchors against')
  }
  const odd = parseTourCreate({ title: 't', changes: { kind: 'stash' }, steps: [] })
  assert.equal(odd.ok, false)
  if (!odd.ok) assert.match(odd.errors[0], /got "stash"/)
})

test('paths stay inside the repository', () => {
  assert.equal(normalizeTourPath('src\\a.ts'), 'src/a.ts')
  assert.equal(normalizeTourPath('/Users/dev/app/src/a.ts'), null)
  assert.equal(normalizeTourPath('C:/app/a.ts'), null)
  assert.equal(normalizeTourPath('src/../../a.ts'), null)
})

test('an update names what it does; omitting `after` appends', () => {
  const append = parseTourUpdate({
    tourId: 't1',
    insertAfter: { steps: [{ id: 'x', title: 'X', body: 'b', path: 'a.ts', hunk: 1 }] },
  })
  assert.equal(append.ok, true)
  if (append.ok) assert.equal(append.value.insertAfter?.after, TOUR_APPEND)
  const front = parseTourUpdate({
    tourId: 't1',
    insertAfter: { after: null, steps: [{ id: 'x', title: 'X', body: 'b', path: 'a.ts', hunk: 1 }] },
  })
  assert.equal(front.ok && front.value.insertAfter?.after, null)
  const empty = parseTourUpdate({ tourId: 't1' })
  assert.equal(empty.ok, false)
})

test('a question arrives prefixed with where it is from', () => {
  const text = tourAskText({
    tour: { id: 't1', title: 'Retry' },
    step: {
      id: 'loop',
      title: 'The loop',
      anchor: { path: 'src/queue/retry.ts', side: 'new', startLine: 40, endLine: 43 },
      startLine: 40,
      endLine: 43,
    },
    index: 1,
    of: 3,
    question: '  Why a cap?  ',
  })
  assert.equal(text, '[Tour "Retry" · step 2/3 "The loop" · src/queue/retry.ts L40–43 (new)]\nWhy a cap?')
})
