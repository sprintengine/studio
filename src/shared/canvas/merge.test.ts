import assert from 'node:assert/strict'

import type { CanvasElement } from './types'
import { CANVAS_TOMBSTONE_TTL_MS, dropStaleTombstones, mergeElements, pickWinner, sceneVersionHash } from './merge'
import { test } from 'vitest'

test('merge', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  function element(
    id: string,
    version: number,
    versionNonce: number,
    extra: Partial<CanvasElement> = {},
  ): CanvasElement {
    return { id, type: 'rectangle', version, versionNonce, ...extra }
  }

  const ids = (elements: CanvasElement[]): string[] => elements.map((element) => element.id)

  run('the higher version wins', () => {
    const merged = mergeElements([element('a', 3, 100, { x: 1 })], [element('a', 4, 999, { x: 2 })])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].x, 2)
    assert.equal(mergeElements([element('a', 5, 1)], [element('a', 4, 1)])[0].version, 5)
  })

  run('on a tie the lower versionNonce wins, whichever side it is on', () => {
    assert.equal(pickWinner(element('a', 4, 50), element('a', 4, 10)).versionNonce, 10)
    assert.equal(pickWinner(element('a', 4, 10), element('a', 4, 50)).versionNonce, 10)
    // Same on both sides of the call: the answer cannot depend on who merged.
    const left = mergeElements([element('a', 4, 50, { x: 1 })], [element('a', 4, 10, { x: 2 })])
    const right = mergeElements([element('a', 4, 10, { x: 2 })], [element('a', 4, 50, { x: 1 })])
    assert.equal(left[0].x, 2)
    assert.equal(right[0].x, 2)
  })

  run('an exact tie keeps the local element', () => {
    const local = element('a', 4, 10, { x: 1 })
    assert.equal(mergeElements([local], [element('a', 4, 10, { x: 2 })])[0], local)
  })

  run('ids on one side only are kept, local order first', () => {
    const merged = mergeElements(
      [element('a', 1, 1), element('b', 1, 1)],
      [element('c', 1, 1), element('a', 1, 1), element('d', 1, 1)],
    )
    assert.deepEqual(ids(merged), ['a', 'b', 'c', 'd'])
  })

  run('a tombstone with a bumped version wins over the live element', () => {
    const merged = mergeElements([element('a', 2, 1)], [element('a', 3, 1, { isDeleted: true })])
    assert.equal(merged[0].isDeleted, true)
    // And a stale live copy does not resurrect it.
    assert.equal(mergeElements(merged, [element('a', 1, 1)])[0].isDeleted, true)
  })

  run('a duplicate id in one side collapses to its first occurrence', () => {
    const merged = mergeElements([element('a', 1, 1, { x: 1 }), element('a', 9, 1, { x: 2 })], [])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].x, 1)
  })

  run('fractional indexes restore paint order in the slots they already hold', () => {
    const merged = mergeElements(
      [element('a', 1, 1, { index: 'a2' }), element('b', 1, 1), element('c', 1, 1, { index: 'a0' })],
      [element('d', 1, 1, { index: 'a1' })],
    )
    // `b` has no index, so it does not move; the three indexed elements sort
    // among positions 0, 2 and 3.
    assert.deepEqual(ids(merged), ['c', 'b', 'd', 'a'])
  })

  run('elements without an index are left exactly where they were', () => {
    const merged = mergeElements([element('a', 1, 1), element('b', 1, 1), element('c', 1, 1)], [])
    assert.deepEqual(ids(merged), ['a', 'b', 'c'])
  })

  run('dropStaleTombstones expires by updated, keeps live and undated', () => {
    const now = 1_000_000_000_000
    const kept = dropStaleTombstones(
      [
        element('live', 1, 1, { updated: 0 }),
        element('fresh', 1, 1, { isDeleted: true, updated: now - CANVAS_TOMBSTONE_TTL_MS + 1 }),
        element('exactly', 1, 1, { isDeleted: true, updated: now - CANVAS_TOMBSTONE_TTL_MS }),
        element('stale', 1, 1, { isDeleted: true, updated: now - CANVAS_TOMBSTONE_TTL_MS - 1 }),
        element('undated', 1, 1, { isDeleted: true }),
      ],
      now,
    )
    assert.deepEqual(ids(kept), ['live', 'fresh', 'exactly', 'undated'])
  })

  run('sceneVersionHash moves on every field a merge can act on', () => {
    const base = [element('a', 1, 1), element('b', 2, 2)]
    const same = sceneVersionHash(base)
    assert.equal(sceneVersionHash([element('a', 1, 1), element('b', 2, 2)]), same)
    assert.notEqual(sceneVersionHash([element('a', 2, 1), element('b', 2, 2)]), same, 'version')
    assert.notEqual(sceneVersionHash([element('a', 1, 9), element('b', 2, 2)]), same, 'versionNonce')
    assert.notEqual(sceneVersionHash([element('a', 1, 1, { isDeleted: true }), element('b', 2, 2)]), same, 'tombstone')
    assert.notEqual(sceneVersionHash([element('a', 1, 1)]), same, 'id set')
    assert.notEqual(sceneVersionHash([...base, element('c', 1, 1)]), same, 'added id')
  })

  run('sceneVersionHash moves when only the paint order does', () => {
    // The Canvas tab compares this hash against the one main pushed to decide
    // whether the editor had to ADJUST the push to accept it — a fractional index
    // it assigned, an element it kept over the remote twin, or a reorder. Paint
    // order is part of what main stores, so a scene that differs only in the
    // order of the same elements has to read as a difference here, or the tab
    // would never tell main about it.
    const a = element('a', 1, 1)
    const b = element('b', 2, 2)
    assert.notEqual(sceneVersionHash([a, b]), sceneVersionHash([b, a]))
  })

  run('sceneVersionHash ignores what a merge cannot act on', () => {
    // The editor fires onChange on pointer move; a cursor that touched nothing
    // must not cost a write.
    assert.equal(sceneVersionHash([element('a', 1, 1, { x: 0 })]), sceneVersionHash([element('a', 1, 1, { x: 400 })]))
  })

  console.log('canvas merge tests passed')
})
