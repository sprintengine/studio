import assert from 'node:assert/strict'

import type { CanvasElement } from './types'
import { findElements, normalizeCanvasSearchText } from './find'
import { test } from 'vitest'

test('find', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  let nonce = 0
  function element(partial: Partial<CanvasElement> & { id: string; type: string }): CanvasElement {
    nonce += 1
    return { version: 1, versionNonce: nonce, ...partial }
  }

  const found = (elements: CanvasElement[], query: Parameters<typeof findElements>[1]): string[] =>
    findElements(elements, query).map((skeleton) => skeleton.id ?? '')

  function scene(): CanvasElement[] {
    return [
      element({
        id: 'box',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        boundElements: [{ id: 'label', type: 'text' }],
      }),
      element({ id: 'label', type: 'text', containerId: 'box', x: 10, y: 10, text: 'Auth Flow' }),
      element({ id: 'note', type: 'text', x: 200, y: 0, width: 100, height: 25, text: 'plain note' }),
      element({ id: 'zone', type: 'frame', x: 0, y: 300, width: 400, height: 200, name: 'auth-flow region' }),
      element({ id: 'far', type: 'ellipse', x: 900, y: 900, width: 40, height: 40 }),
    ]
  }

  run('normalizeCanvasSearchText drops case and every separator', () => {
    assert.equal(normalizeCanvasSearchText('Auth Flow'), 'authflow')
    assert.equal(normalizeCanvasSearchText('auth-flow'), 'authflow')
    assert.equal(normalizeCanvasSearchText('auth_flow'), 'authflow')
    assert.equal(normalizeCanvasSearchText('  AUTH   FLOW  '), 'authflow')
  })

  run('the three spellings of one name all find the labelled shape', () => {
    for (const query of ['Auth Flow', 'auth-flow', 'authflow', 'AUTHFLOW', 'auth_flow']) {
      assert.ok(found(scene(), { query }).includes('box'), query)
    }
  })

  run('a bound label is searched, and answers as its container', () => {
    const hits = found(scene(), { query: 'auth' })
    assert.ok(hits.includes('box'))
    assert.ok(!hits.includes('label'), 'the label is not returned on its own')
  })

  run('frame names and ids are searched too', () => {
    assert.ok(found(scene(), { query: 'region' }).includes('zone'))
    assert.deepEqual(found(scene(), { query: 'far' }), ['far'])
  })

  run('a partial match still hits, and a non-match returns nothing', () => {
    assert.ok(found(scene(), { query: 'thfl' }).includes('box'))
    assert.deepEqual(found(scene(), { query: 'database' }), [])
  })

  run('type narrows to one element kind', () => {
    assert.deepEqual(found(scene(), { type: 'frame' }), ['zone'])
    assert.deepEqual(found(scene(), { type: 'text' }), ['note'])
  })

  run('ids select exactly what was named', () => {
    assert.deepEqual(found(scene(), { ids: ['far', 'note'] }), ['note', 'far'])
    assert.deepEqual(found(scene(), { ids: ['missing'] }), [])
  })

  run('bbox is intersect, not containment', () => {
    // A window over the left half: the box starts inside it and runs past its edge.
    assert.ok(found(scene(), { bbox: { x: 0, y: 0, width: 50, height: 25 } }).includes('box'))
    // Touching at an edge counts as intersecting.
    assert.ok(found(scene(), { bbox: { x: 100, y: 50, width: 1, height: 1 } }).includes('box'))
    assert.deepEqual(found(scene(), { bbox: { x: 880, y: 880, width: 100, height: 100 } }), ['far'])
    assert.deepEqual(found(scene(), { bbox: { x: 2000, y: 2000, width: 10, height: 10 } }), [])
  })

  run('filters combine', () => {
    assert.deepEqual(found(scene(), { query: 'auth', type: 'rectangle' }), ['box'])
    assert.deepEqual(found(scene(), { query: 'auth', type: 'ellipse' }), [])
  })

  run('no filter returns the whole board as skeletons', () => {
    assert.deepEqual(found(scene(), {}), ['box', 'note', 'zone', 'far'])
  })

  console.log('canvas find tests passed')
})
