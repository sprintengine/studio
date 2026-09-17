import assert from 'node:assert/strict'

import type { CanvasElement, CanvasSkeleton } from '../../../shared/canvas/types'
import { canvasFontFamilyName } from '../../../shared/canvas/skeleton'
import {
  CANVAS_FONT_FAMILY_ID,
  canvasRoundness,
  carryFrom,
  labelFitBox,
  patchNeedsRebuild,
  toLibrarySkeleton,
} from './skeletonMap'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const box = (over: Partial<CanvasSkeleton> = {}): CanvasSkeleton => ({
  type: 'rectangle',
  x: 10,
  y: 20,
  ...over,
})

run('the three voices map to the families the editor gives new elements', () => {
  assert.deepEqual(CANVAS_FONT_FAMILY_ID, { hand: 5, normal: 6, code: 8 })
  // And back again, through the shared projection the tools read.
  for (const [name, id] of Object.entries(CANVAS_FONT_FAMILY_ID)) {
    assert.equal(canvasFontFamilyName(id), name)
  }
})

run('a shape is rounded unless the caller says otherwise, by its own algorithm', () => {
  assert.deepEqual(canvasRoundness('rectangle', undefined), { type: 3 })
  assert.deepEqual(canvasRoundness('diamond', undefined), { type: 2 })
  assert.deepEqual(canvasRoundness('arrow', undefined), { type: 2 })
  assert.equal(canvasRoundness('ellipse', undefined), null)
  assert.equal(canvasRoundness('rectangle', false), null)
})

run('only a patch that changes geometry or text asks for a rebuild', () => {
  assert.equal(patchNeedsRebuild({ strokeColor: '#ff0000', opacity: 50 }), false)
  assert.equal(patchNeedsRebuild({ locked: true }), false)
  assert.equal(patchNeedsRebuild({ x: 10 }), true)
  assert.equal(patchNeedsRebuild({ text: 'hello' }), true)
  assert.equal(patchNeedsRebuild({ startElementId: 'a' }), true)
  // An explicitly absent field is not a change.
  assert.equal(patchNeedsRebuild({ x: undefined }), false)
})

run('a label sizes its shape by the measure the board lint uses', () => {
  const fit = labelFitBox('Draft', 20, 'rectangle')
  // Five characters at 0.6em plus the lint's own padding, and a pixel over so
  // the comparison is not decided on the boundary.
  assert.equal(fit.width, Math.ceil(5 * 20 * 0.6 + 16) + 1)
  assert.equal(fit.height, Math.ceil(1 * 20 * 1.25 + 10) + 1)
  // Which is exactly what the lint asks for, and no less.
  assert.ok(fit.width > 5 * 20 * 0.6 + 16)
  assert.ok(fit.height > 1 * 20 * 1.25)
  // A label sits in the largest rectangle that fits inside the shape, so the
  // shapes that are not rectangles need more of themselves to hold the same text.
  assert.ok(labelFitBox('Draft', 20, 'diamond').width > fit.width)
  assert.ok(labelFitBox('Draft', 20, 'ellipse').width > fit.width)
  assert.ok(labelFitBox('Draft', 20, 'diamond').width > labelFitBox('Draft', 20, 'ellipse').width)
  // Two lines need two lines' worth of height.
  assert.ok(labelFitBox('one\ntwo', 20, 'rectangle').height > fit.height)
})

run('a labelled shape is grown to fit rather than left to overflow', () => {
  const skeleton = toLibrarySkeleton({ id: 'a', skeleton: box({ text: 'A long label here', width: 40, height: 10 }) })
  const fit = labelFitBox('A long label here', 20, 'rectangle')
  assert.equal(skeleton.width, fit.width)
  assert.equal(skeleton.height, fit.height)
  const label = skeleton.label as Record<string, unknown>
  assert.equal(label.text, 'A long label here')
  assert.equal(label.fontFamily, 5)
  assert.equal(label.verticalAlign, 'middle')
})

run('a shape wider than its label keeps the width it was asked for', () => {
  const skeleton = toLibrarySkeleton({ id: 'a', skeleton: box({ text: 'Hi', width: 300, height: 200 }) })
  assert.equal(skeleton.width, 300)
  assert.equal(skeleton.height, 200)
})

run('a rebuild carries the identity of the element it replaces', () => {
  const element: CanvasElement = {
    id: 'a',
    type: 'rectangle',
    version: 7,
    versionNonce: 42,
    seed: 1234,
    index: 'a2',
    groupIds: ['g1'],
    frameId: 'f1',
    boundElements: [
      { id: 't1', type: 'text' },
      { id: 'arrow1', type: 'arrow' },
    ],
  }
  const carry = carryFrom(element)
  const skeleton = toLibrarySkeleton({ id: 'a', skeleton: box({ text: 'Hi' }), carry, labelId: 't1' })
  assert.equal(skeleton.seed, 1234)
  assert.equal(skeleton.version, 7)
  assert.equal(skeleton.index, 'a2')
  assert.equal(skeleton.frameId, 'f1')
  assert.deepEqual(skeleton.groupIds, ['g1'])
  // The label is re-bound by the converter, which concatenates: left in place
  // the old reference would be listed twice.
  assert.deepEqual(skeleton.boundElements, [{ id: 'arrow1', type: 'arrow' }])
  assert.equal((skeleton.label as Record<string, unknown>).id, 't1')
})

run('an arrow carries its resolved ends and its routed points', () => {
  const skeleton = toLibrarySkeleton({
    id: 'arrow1',
    skeleton: { type: 'arrow', x: 0, y: 0, text: 'next' },
    linear: { x: 100, y: 50, points: [[0, 0], [80, 0]] },
    startId: 'a',
    endId: 'b',
  })
  assert.equal(skeleton.x, 100)
  assert.equal(skeleton.y, 50)
  assert.deepEqual(skeleton.points, [[0, 0], [80, 0]])
  assert.equal(skeleton.width, 80)
  assert.deepEqual(skeleton.start, { id: 'a' })
  assert.deepEqual(skeleton.end, { id: 'b' })
  assert.equal((skeleton.label as Record<string, unknown>).text, 'next')
})

run('a text element sizes itself and belongs to no container', () => {
  const skeleton = toLibrarySkeleton({
    id: 't',
    skeleton: { type: 'text', x: 5, y: 6, text: 'note', fontFamily: 'code', textAlign: 'right' },
  })
  assert.equal(skeleton.text, 'note')
  assert.equal(skeleton.fontFamily, 8)
  assert.equal(skeleton.textAlign, 'right')
  assert.equal(skeleton.autoResize, true)
  assert.equal(skeleton.containerId, null)
  assert.equal(skeleton.label, undefined)
})
