import assert from 'node:assert/strict'

import type { ChangeMap } from '../../../../shared/review'
import { computeChangeMapLayout, describeChangeMap } from './changeMapLayout'
import { mockupChangeMap, mockupChangeMapStepIds } from './fixtures'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function node(layout: ReturnType<typeof computeChangeMapLayout>, id: string) {
  const found = layout.nodes.find((n) => n.id === id)
  assert.ok(found, `node ${id} missing from layout`)
  return found
}

run('lays the mockup map out in step-order columns with stable coordinates', () => {
  const layout = computeChangeMapLayout(mockupChangeMap, mockupChangeMapStepIds)

  // Four step columns; the tallest (two-node) columns set the 922x162 viewBox.
  assert.equal(layout.width, 922)
  assert.equal(layout.height, 162)

  // Column x increases left-to-right by reading order; the two-node columns pin
  // their rows to the top, the one-node columns centre against the tallest.
  assert.deepEqual(
    { x: node(layout, 'model').x, y: node(layout, 'model').y },
    { x: 14, y: 14 },
  )
  assert.deepEqual(
    { x: node(layout, 'migration').x, y: node(layout, 'migration').y },
    { x: 14, y: 92 },
  )
  assert.deepEqual({ x: node(layout, 'api').x, y: node(layout, 'api').y }, { x: 256, y: 14 })
  assert.deepEqual({ x: node(layout, 'email').x, y: node(layout, 'email').y }, { x: 256, y: 92 })
  assert.deepEqual({ x: node(layout, 'ui').x, y: node(layout, 'ui').y }, { x: 498, y: 53 })
  assert.deepEqual({ x: node(layout, 'tests').x, y: node(layout, 'tests').y }, { x: 740, y: 53 })
})

run('stacks same-step nodes vertically in one column', () => {
  const layout = computeChangeMapLayout(mockupChangeMap, mockupChangeMapStepIds)
  const model = node(layout, 'model')
  const migration = node(layout, 'migration')
  assert.equal(model.x, migration.x) // same step → same column
  assert.ok(migration.y > model.y) // stacked in node order
})

run('badges each node with its step reading position, not the dense column', () => {
  const layout = computeChangeMapLayout(mockupChangeMap, mockupChangeMapStepIds)
  assert.equal(node(layout, 'model').stepBadge, 1)
  assert.equal(node(layout, 'migration').stepBadge, 1)
  assert.equal(node(layout, 'api').stepBadge, 2)
  assert.equal(node(layout, 'ui').stepBadge, 3)
  assert.equal(node(layout, 'tests').stepBadge, 4)
})

run('badge follows the true step number even when an earlier step has no nodes', () => {
  // s-api has no nodes here, so its column collapses, but the ui node keeps
  // badge 3 (its reading position) while sitting in the second column.
  const gapped: ChangeMap = {
    nodes: [
      { id: 'model', label: 'Model', stepId: 's-model', kind: 'data' },
      { id: 'ui', label: 'UI', stepId: 's-ui', kind: 'ui' },
    ],
    edges: [],
  }
  const layout = computeChangeMapLayout(gapped, mockupChangeMapStepIds)
  const ui = node(layout, 'ui')
  assert.equal(ui.stepBadge, 3) // s-ui is the third step
  assert.equal(ui.x, 256) // but only the second occupied column
})

run('routes every edge to a path with an entry point, keeping edge labels', () => {
  const layout = computeChangeMapLayout(mockupChangeMap, mockupChangeMapStepIds)
  assert.equal(layout.edges.length, 5)
  for (const edge of layout.edges) {
    assert.match(edge.path, /^M [\d.-]+ [\d.-]+ C /)
  }
  const feeds = layout.edges.find((e) => e.from === 'api' && e.to === 'ui')
  assert.equal(feeds?.label, 'feeds')
})

run('same brief produces the same layout (deterministic)', () => {
  const a = computeChangeMapLayout(mockupChangeMap, mockupChangeMapStepIds)
  const b = computeChangeMapLayout(mockupChangeMap, mockupChangeMapStepIds)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

run('summarizes the map as prose for screen readers', () => {
  const summary = describeChangeMap(mockupChangeMap)
  assert.match(summary, /Change map of 6 entities/)
  assert.match(summary, /Migration creates Invitation model/)
  assert.match(summary, /API tests covers Invitations API/)
  assert.match(summary, /Deploy order: migration before UI/)
})

run('an empty map yields an empty, zero-size layout', () => {
  const layout = computeChangeMapLayout({ nodes: [], edges: [] }, mockupChangeMapStepIds)
  assert.equal(layout.width, 0)
  assert.equal(layout.height, 0)
  assert.equal(layout.nodes.length, 0)
  assert.equal(layout.edges.length, 0)
  assert.match(layout.ariaLabel, /Change map of 0 entities/)
})

console.log('all change-map layout tests passed')
