import assert from 'node:assert/strict'

import type { CanvasElement } from './types'
import { CANVAS_DIFF_MAX_LINES, summariseChanges } from './diff'
import { test } from 'vitest'

test('diff', async () => {
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

  function labelled(id: string, text: string, x: number, y: number, width = 160, height = 80): CanvasElement[] {
    return [
      element({
        id,
        type: 'rectangle',
        x,
        y,
        width,
        height,
        boundElements: [{ id: `${id}-label`, type: 'text' }],
      }),
      element({ id: `${id}-label`, type: 'text', containerId: id, x: x + 10, y: y + 20, text, originalText: text }),
    ]
  }

  run('an unchanged board reports nothing', () => {
    const scene = labelled('r1', 'API', 120, 80)
    assert.deepEqual(summariseChanges(scene, scene), [])
  })

  run('added names the kind, the label and where it landed', () => {
    const after = labelled('r1', 'API', 120, 80)
    assert.deepEqual(summariseChanges([], after), ['Added rectangle "API" at (120,80)'])
  })

  run('an unlabelled element is named by its id', () => {
    const after = [element({ id: 'r9', type: 'ellipse', x: 5, y: 6, width: 10, height: 10 })]
    assert.deepEqual(summariseChanges([], after), ['Added ellipse r9 at (5,6)'])
  })

  run('removed names what is gone, whether deleted outright or tombstoned', () => {
    const before = labelled('r1', 'Cache', 0, 0)
    assert.deepEqual(summariseChanges(before, []), ['Removed "Cache"'])
    const tombstoned = before.map((entry) => ({ ...entry, isDeleted: true }))
    assert.deepEqual(summariseChanges(before, tombstoned), ['Removed "Cache"'])
  })

  run('moved and resized report the new geometry', () => {
    const before = labelled('r1', 'DB', 100, 100)
    const moved = labelled('r1', 'DB', 400, 220)
    assert.deepEqual(summariseChanges(before, moved), ['Moved "DB" to (400,220)'])

    const resized = labelled('r1', 'DB', 100, 100, 200, 120)
    assert.deepEqual(summariseChanges(before, resized), ['Resized "DB" to 200x120'])

    const both = labelled('r1', 'DB', 400, 220, 200, 120)
    assert.deepEqual(summariseChanges(before, both), ['Moved "DB" to (400,220) and resized to 200x120'])
  })

  run('a sub-pixel nudge is not a move', () => {
    const before = labelled('r1', 'DB', 100, 100)
    const nudged = labelled('r1', 'DB', 100.9, 100)
    assert.deepEqual(summariseChanges(before, nudged), [])
    const moved = labelled('r1', 'DB', 101, 100)
    assert.deepEqual(summariseChanges(before, moved), ['Moved "DB" to (101,100)'])
  })

  run('an edited bound label is reported as its container being relabelled', () => {
    const before = labelled('r1', 'Svc', 0, 0)
    const after = labelled('r1', 'Service', 0, 0)
    const lines = summariseChanges(before, after)
    assert.deepEqual(lines, ['Relabelled "Svc" -> "Service"'])
    // The label element itself is never an entry of its own.
    assert.ok(!lines.some((line) => line.includes('r1-label')))
  })

  run('a label appearing or vanishing is still the container being relabelled', () => {
    const plain = [element({ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 160, height: 80 })]
    assert.deepEqual(summariseChanges(plain, labelled('r1', 'API', 0, 0)), ['Relabelled rectangle r1 -> "API"'])
    assert.deepEqual(summariseChanges(labelled('r1', 'API', 0, 0), plain), ['Relabelled "API" -> (no label)'])
  })

  run('changes are grouped added, removed, geometry, relabelled', () => {
    const before = [...labelled('a', 'Keep', 0, 0), ...labelled('b', 'Old', 0, 200), ...labelled('c', 'Move', 0, 400)]
    const after = [...labelled('a', 'Kept', 0, 0), ...labelled('c', 'Move', 500, 400), ...labelled('d', 'New', 0, 600)]
    assert.deepEqual(summariseChanges(before, after), [
      'Added rectangle "New" at (0,600)',
      'Removed "Old"',
      'Moved "Move" to (500,400)',
      'Relabelled "Keep" -> "Kept"',
    ])
  })

  run('a rewrite is capped, with the count of what was left out', () => {
    const after: CanvasElement[] = []
    for (let i = 0; i < CANVAS_DIFF_MAX_LINES + 12; i += 1) {
      after.push(element({ id: `r${i}`, type: 'rectangle', x: i * 200, y: 0, width: 100, height: 60 }))
    }
    const lines = summariseChanges([], after)
    assert.equal(lines.length, CANVAS_DIFF_MAX_LINES + 1)
    assert.equal(lines[CANVAS_DIFF_MAX_LINES], '... and 12 more change(s). Re-read the board.')
  })

  console.log('canvas diff tests passed')
})
