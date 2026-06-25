import assert from 'node:assert/strict'

import {
  SIDEBAR_COLLAPSE_SNAP_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  resolveSidebarResize,
} from './sidebarWidth'

function testClampBounds(): void {
  assert.equal(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 50), SIDEBAR_MIN_WIDTH, 'clamps up to min')
  assert.equal(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 50), SIDEBAR_MAX_WIDTH, 'clamps down to max')
  assert.equal(clampSidebarWidth(300), 300, 'passes through an in-range width')
  assert.equal(clampSidebarWidth(300.6), 301, 'rounds to whole px')
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT_WIDTH, 'NaN falls back to default')
}

function testResizeSnapsToCollapse(): void {
  // Anything narrower than the snap threshold collapses the rail.
  assert.deepEqual(resolveSidebarResize(SIDEBAR_COLLAPSE_SNAP_WIDTH - 1), { kind: 'collapse' })
  assert.deepEqual(resolveSidebarResize(0), { kind: 'collapse' })
  assert.deepEqual(resolveSidebarResize(-200), { kind: 'collapse' }, 'dragging past the left edge collapses')
}

function testResizeProducesClampedWidth(): void {
  // At/above the snap threshold it stays expanded, clamped into the valid range.
  // The snap threshold sits below the min width, so a width in the dead band
  // between them still resolves to the min, never collapse.
  assert.deepEqual(resolveSidebarResize(SIDEBAR_COLLAPSE_SNAP_WIDTH), {
    kind: 'width',
    width: SIDEBAR_MIN_WIDTH,
  })
  assert.deepEqual(resolveSidebarResize(320), { kind: 'width', width: 320 })
  assert.deepEqual(resolveSidebarResize(9999), { kind: 'width', width: SIDEBAR_MAX_WIDTH })
}

function testThresholdOrdering(): void {
  // Invariant the drag math relies on: the collapse snap is strictly below the
  // minimum expanded width, so there is a dead band rather than an overlap.
  assert.ok(
    SIDEBAR_COLLAPSE_SNAP_WIDTH < SIDEBAR_MIN_WIDTH,
    'collapse snap must be below the minimum expanded width'
  )
}

testClampBounds()
testResizeSnapsToCollapse()
testResizeProducesClampedWidth()
testThresholdOrdering()
console.log('sidebar-width tests passed')
