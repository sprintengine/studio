import assert from 'node:assert/strict'

import type { CanvasElement } from './types'
import { CANVAS_DESCRIBE_MAX_CHARS, describeScene } from './describe'
import { test } from 'vitest'

test('describe', async () => {
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

  function scene(): CanvasElement[] {
    return [
      element({
        id: 'r1',
        type: 'rectangle',
        x: 120,
        y: 80,
        width: 160,
        height: 80,
        boundElements: [{ id: 't1', type: 'text' }],
      }),
      element({ id: 't1', type: 'text', containerId: 'r1', x: 130, y: 100, width: 40, height: 25, text: 'API' }),
      element({
        id: 'r2',
        type: 'rectangle',
        x: 480,
        y: 80,
        width: 160,
        height: 80,
        boundElements: [{ id: 't2', type: 'text' }],
      }),
      element({ id: 't2', type: 'text', containerId: 'r2', x: 490, y: 100, width: 60, height: 25, text: 'Cache' }),
      element({
        id: 'a1',
        type: 'arrow',
        x: 280,
        y: 120,
        width: 200,
        height: 0,
        points: [
          [0, 0],
          [200, 0],
        ],
        startBinding: { elementId: 'r1', focus: 0, gap: 4 },
        endBinding: { elementId: 'r2', focus: 0, gap: 4 },
      }),
      element({ id: 'g1', type: 'ellipse', x: 0, y: 400, width: 40, height: 40, groupIds: ['grp'] }),
      element({ id: 'g2', type: 'ellipse', x: 60, y: 400, width: 40, height: 40, groupIds: ['grp'] }),
    ]
  }

  run('summary counts elements and gives the bounding box, nothing else', () => {
    const text = describeScene(scene(), 'summary')
    assert.match(text, /^Board: 5 element\(s\) \(1 arrow, 2 ellipse, 2 rectangle\)\./m)
    assert.match(text, /Bounds: \(0,80\) 640x360\./)
    assert.ok(!text.includes('Elements'), 'summary lists no elements')
  })

  run('outline writes one deterministic line per element, top-to-bottom', () => {
    const text = describeScene(scene(), 'outline')
    const lines = text.split('\n')
    const start = lines.indexOf('Elements') + 1
    assert.equal(lines[start], '[r1] rectangle at (120,80) 160x80 "API"')
    assert.equal(lines[start + 1], '[r2] rectangle at (480,80) 160x80 "Cache"')
    assert.equal(lines[start + 2], '[a1] arrow at (280,120) 200x0 -> "Cache"')
    assert.equal(describeScene(scene(), 'outline'), text, 'the same scene describes the same way twice')
  })

  run('a bound label is folded, never listed as its own element', () => {
    const text = describeScene(scene(), 'outline')
    assert.ok(!text.includes('[t1]'))
    assert.ok(!text.includes('[t2]'))
  })

  run('the Connections section names both ends by label', () => {
    const text = describeScene(scene(), 'outline')
    assert.match(text, /\nConnections\n"API" --> "Cache" \(a1\)/)
  })

  run('an arrow with a dangling or missing end is flagged unattached', () => {
    const elements = scene()
    elements.push(
      element({ id: 'a2', type: 'arrow', x: 0, y: 0, startBinding: { elementId: 'r1', focus: 0, gap: 4 } }),
      element({ id: 'a3', type: 'arrow', x: 0, y: 0, endBinding: { elementId: 'gone', focus: 0, gap: 4 } }),
    )
    const text = describeScene(elements, 'outline')
    assert.match(text, /"API" --> \? \(a2\) \(unattached\)/)
    assert.match(text, /\? --> \? \(a3\) \(unattached\)/)
  })

  run('Connections falls back to ids when an end has no label', () => {
    const elements = [
      element({ id: 'plain', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 }),
      element({ id: 'other', type: 'rectangle', x: 200, y: 0, width: 50, height: 50 }),
      element({
        id: 'a1',
        type: 'arrow',
        x: 50,
        y: 25,
        startBinding: { elementId: 'plain', focus: 0, gap: 4 },
        endBinding: { elementId: 'other', focus: 0, gap: 4 },
      }),
    ]
    assert.match(describeScene(elements, 'outline'), /plain --> other \(a1\)/)
  })

  run('groups and frames get their own sections', () => {
    const elements = scene()
    elements.push(element({ id: 'f1', type: 'frame', x: 0, y: 700, width: 200, height: 100, name: 'Auth' }))
    elements.push(element({ id: 'in', type: 'rectangle', x: 10, y: 710, width: 20, height: 20, frameId: 'f1' }))
    const text = describeScene(elements, 'outline')
    assert.match(text, /\nGroups\ngrp: g1, g2/)
    assert.match(text, /\nFrames\n\[f1\] "Auth" holds 1: in/)
  })

  run('a label is clipped at 80 characters', () => {
    const long = 'x'.repeat(200)
    const elements = [element({ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, text: long })]
    const line =
      describeScene(elements, 'outline')
        .split('\n')
        .find((entry) => entry.startsWith('[r1]')) ?? ''
    assert.ok(line.includes(`${'x'.repeat(79)}...`), line)
    assert.ok(!line.includes('x'.repeat(81)))
  })

  run('detail: full adds style notes the outline leaves out', () => {
    const elements = [
      element({ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: '#e03131', locked: true }),
    ]
    assert.ok(!describeScene(elements, 'outline').includes('#e03131'))
    assert.match(describeScene(elements, 'full'), /\[stroke #e03131, locked\]/)
  })

  run('a huge board is bounded, and says how many elements it left out', () => {
    const elements: CanvasElement[] = []
    for (let i = 0; i < 2000; i += 1) {
      elements.push(
        element({
          id: `element-${i}`,
          type: 'rectangle',
          x: i * 10,
          y: i * 10,
          width: 100,
          height: 40,
          text: `a reasonably long label for element number ${i}`,
        }),
      )
    }
    const text = describeScene(elements, 'outline')
    assert.ok(text.length <= CANVAS_DESCRIBE_MAX_CHARS, `describe was ${text.length} characters`)
    const last = text.split('\n').pop() ?? ''
    assert.match(last, /^\.\.\. truncated at 24000 characters: (\d+) more element\(s\)/)
    const omitted = Number(/: (\d+) more element/.exec(last)?.[1] ?? '0')
    assert.ok(omitted > 0 && omitted < 2000, `omitted count ${omitted}`)
  })

  run('an empty board says so rather than inventing a bounding box', () => {
    assert.match(describeScene([], 'outline'), /Bounds: empty board\./)
  })

  console.log('canvas describe tests passed')
})
