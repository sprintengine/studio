import assert from 'node:assert/strict'

import type { CanvasElement } from '../../../shared/canvas/types'
import { SceneDraft, sameContent, stampVersion, withChanges } from './versioning'
import type { Stamp } from './versioning'
import { test } from 'vitest'

test('versioning', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  let nonce = 1000
  const stamp: Stamp = { now: () => 42, nonce: () => (nonce += 1) }

  const element = (id: string, over: Partial<CanvasElement> = {}): CanvasElement => ({
    id,
    type: 'rectangle',
    version: 3,
    versionNonce: 7,
    x: 0,
    y: 0,
    ...over,
  })

  run('bookkeeping fields are not content', () => {
    const a = element('a')
    assert.equal(sameContent(a, { ...a, version: 99, versionNonce: 1, updated: 5 }), true)
    assert.equal(sameContent(a, { ...a, x: 1 }), false)
    // A field this code has never heard of still counts: the element type carries
    // an index signature precisely so nothing is dropped on the floor.
    assert.equal(sameContent(a, { ...a, somethingNew: 1 }), false)
  })

  run('a changed element comes back strictly above the version it replaced', () => {
    const before = element('a')
    const after = stampVersion({ ...before, x: 10 }, before, stamp)
    assert.equal(after.version, 4)
    assert.notEqual(after.versionNonce, before.versionNonce)
    assert.equal(after.updated, 42)
  })

  run('a converter that already bumped is not wound back', () => {
    const before = element('a', { version: 3 })
    const after = stampVersion({ ...before, version: 9, x: 10 }, before, stamp)
    assert.equal(after.version, 9)
  })

  run('an element that did not really change comes back as itself', () => {
    const before = element('a')
    const after = stampVersion({ ...before, version: 8, versionNonce: 1 }, before, stamp)
    assert.equal(after, before)
  })

  run('a new element keeps the version it was given', () => {
    const minted = stampVersion(element('n', { version: 1 }), undefined, stamp)
    assert.equal(minted.version, 1)
    assert.equal(minted.updated, 42)
  })

  run('a draft keeps order, keeps untouched elements identical, and appends the new', () => {
    const a = element('a')
    const b = element('b', { x: 5 })
    const draft = new SceneDraft([a, b])

    draft.patch('b', { x: 50 }, stamp)
    draft.put(element('c'))

    const out = draft.all()
    assert.deepEqual(
      out.map((e) => e.id),
      ['a', 'b', 'c'],
    )
    // Untouched: the very same object, so main's merge sees no write at all.
    assert.equal(out[0], a)
    assert.equal(out[1].x, 50)
    assert.equal(out[1].version, 4)
    assert.deepEqual(draft.changedIds().sort(), ['b', 'c'])
  })

  run('a patch that changes nothing changes no version', () => {
    const a = element('a', { x: 5 })
    const draft = new SceneDraft([a])
    draft.patch('a', { x: 5 }, stamp)
    assert.equal(draft.all()[0], a)
    assert.deepEqual(draft.changedIds(), [])
  })

  run('a tombstone stays in the array, it is not removed from it', () => {
    const draft = new SceneDraft([element('a'), element('b')])
    draft.patch('a', { isDeleted: true }, stamp)
    assert.equal(draft.all().length, 2)
    assert.equal(draft.live().length, 1)
    assert.equal(draft.get('a')!.isDeleted, true)
    assert.ok(draft.get('a')!.version > 3)
  })

  run('the original is still readable after a patch', () => {
    const a = element('a', { x: 1 })
    const draft = new SceneDraft([a])
    draft.patch('a', { x: 2 }, stamp)
    assert.equal(draft.originalOf('a'), a)
    assert.equal(draft.get('a')!.x, 2)
  })

  run('a duplicate id is kept once, at the position it first appeared', () => {
    const draft = new SceneDraft([element('a', { x: 1 }), element('b'), element('a', { x: 2 })])
    assert.deepEqual(
      draft.all().map((e) => e.id),
      ['a', 'b'],
    )
    assert.equal(draft.get('a')!.x, 1)
  })

  run('withChanges leaves the element it was handed alone', () => {
    const a = element('a')
    const next = withChanges(a, { x: 9 }, stamp)
    assert.equal(a.x, 0)
    assert.equal(next.x, 9)
  })
})
