import assert from 'node:assert/strict'
import { test } from 'vitest'

import { FLOAT_MAX_WIDTH, FLOAT_MIN_HEIGHT, FLOAT_MIN_WIDTH } from '../../../store/slices/workspacePaneSlice'
import { FLOAT_EDGE_GAP_FALLBACK as GAP, resizeFloatRect } from './FloatingPlayer'

// Resizing the floating player from any edge or corner: the edges not being
// dragged stay put, and the limits and the window still hold.

const VIEWPORT = { width: 1400, height: 900 }
const START = { left: 600, top: 300, width: 400, height: 300 }

test('dragging the right edge grows the width and leaves the left edge where it was', () => {
  assert.deepEqual(resizeFloatRect(START, { e: true }, 50, 20, VIEWPORT), { ...START, width: 450 })
})

test('dragging the left edge moves the left edge and keeps the right edge anchored', () => {
  const next = resizeFloatRect(START, { w: true }, -100, 0, VIEWPORT)
  assert.equal(next.left, 500)
  assert.equal(next.left + next.width, START.left + START.width)
})

test('dragging the top edge keeps the bottom edge anchored', () => {
  const next = resizeFloatRect(START, { n: true }, 0, -50, VIEWPORT)
  assert.equal(next.top, 250)
  assert.equal(next.top + next.height, START.top + START.height)
})

test('a corner moves both of its edges', () => {
  const next = resizeFloatRect(START, { n: true, w: true }, -20, -30, VIEWPORT)
  assert.deepEqual(next, { left: 580, top: 270, width: 420, height: 330 })
})

test('shrinking past the floor stops the dragged edge, not the anchored one', () => {
  const next = resizeFloatRect(START, { w: true }, 1000, 0, VIEWPORT)
  assert.equal(next.width, FLOAT_MIN_WIDTH)
  assert.equal(next.left + next.width, START.left + START.width)
  const shorter = resizeFloatRect(START, { n: true }, 0, 1000, VIEWPORT)
  assert.equal(shorter.height, FLOAT_MIN_HEIGHT)
  assert.equal(shorter.top + shorter.height, START.top + START.height)
})

test('growing stops at the ceiling and at the window edge', () => {
  const wide = resizeFloatRect({ left: GAP, top: GAP, width: 400, height: 300 }, { e: true }, 5000, 0, VIEWPORT)
  assert.equal(wide.width, FLOAT_MAX_WIDTH)
  const atEdge = resizeFloatRect(START, { e: true }, 5000, 0, VIEWPORT)
  assert.ok(atEdge.left + atEdge.width <= VIEWPORT.width - GAP, 'it stops a token’s gap short of the window edge')
  const up = resizeFloatRect(START, { n: true }, 0, -5000, VIEWPORT)
  assert.equal(up.top, GAP)
})

test('the default corner is lifted clear of the composer when they would overlap', async () => {
  const { clearOfComposer } = await import('./FloatingPlayer')
  const corner = { x: 1032, y: 652, width: 360, height: 240 }
  const composer = { left: 490, top: 737, right: 1258, bottom: 880 }
  assert.deepEqual(clearOfComposer(corner, composer), { ...corner, y: 737 - GAP - 240 })
})

test('the default corner stands when it clears the composer, or there is no room above it', async () => {
  const { clearOfComposer } = await import('./FloatingPlayer')
  const corner = { x: 1032, y: 652, width: 360, height: 240 }
  assert.deepEqual(clearOfComposer(corner, null), corner)
  assert.deepEqual(clearOfComposer(corner, { left: 100, top: 737, right: 900, bottom: 880 }), corner)
  assert.deepEqual(clearOfComposer(corner, { left: 490, top: 120, right: 1258, bottom: 880 }), corner)
})
