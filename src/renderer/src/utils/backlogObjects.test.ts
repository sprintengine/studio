import assert from 'node:assert/strict'

import { createBacklogItem } from './backlog'
import {
  addBacklogObjectLink,
  ensureBacklogObjectRecords,
  hydrateBacklogScanResult,
  moveBacklogObjectSource,
  removeBacklogObjectRecord,
  updateBacklogObjectStatus,
  updateBacklogObjectTriage,
  updateBacklogObjectType,
  type BacklogObjectStore,
} from './backlogObjects'

const item = createBacklogItem({
  path: '/repo/backlog/checkout.md',
  relativePath: 'backlog/checkout.md',
  sourceContent: '# Checkout\nBuild it.',
  stats: { modifiedAtMs: 10, sizeBytes: 20 },
})

const store: BacklogObjectStore = {
  schemaVersion: 1,
  items: [
    {
      id: 'item_checkout',
      source: { type: 'file', relativePath: 'backlog/checkout.md' },
      status: 'in_progress',
      type: 'feature',
      difficulty: 'm',
      criticality: 'high',
      metadata: { 'sprint-engine': { lastRunId: 'checkout' } },
      links: [
        {
          id: 'sprint-engine:checkout',
          moduleId: 'sprint-engine',
          type: 'execution',
          label: 'Sprint Engine run',
          target: { kind: 'sprintengine.run', id: 'checkout', path: '.multi-code/sprintengine/checkout/run.yaml' },
          status: 'active',
        },
      ],
      updatedAt: '2026-06-07T00:00:00.000Z',
    },
  ],
}

const hydrated = hydrateBacklogScanResult({ state: 'ready', items: [item], errors: [] }, store)
assert.equal(hydrated.items[0]?.objectId, 'item_checkout')
assert.equal(hydrated.items[0]?.status, 'in_progress')
assert.equal(hydrated.items[0]?.links[0]?.target.path, '.multi-code/sprintengine/checkout/run.yaml')
// Triage metadata is surfaced from the object record onto the hydrated item.
assert.equal(hydrated.items[0]?.type, 'feature')
assert.equal(hydrated.items[0]?.difficulty, 'm')
assert.equal(hydrated.items[0]?.criticality, 'high')

const ensured = ensureBacklogObjectRecords({ schemaVersion: 1, items: [] }, [item], '2026-06-07T01:00:00.000Z')
assert.equal(ensured.changed, true)
assert.equal(ensured.store.items[0]?.source.relativePath, 'backlog/checkout.md')
// New records adopt the item's calm default status, not a needs_structure flag.
assert.equal(ensured.store.items[0]?.status, 'idea')

const typed = updateBacklogObjectType(store, item, 'bug', '2026-06-07T05:30:00.000Z')
assert.equal(typed.items[0]?.type, 'bug')
assert.equal(typed.items[0]?.updatedAt, '2026-06-07T05:30:00.000Z')

const clearedType = updateBacklogObjectType(typed, item, null, '2026-06-07T05:45:00.000Z')
assert.equal(clearedType.items[0]?.type, undefined)

// Triage edits set, then clear, an axis; the other axis is untouched.
const sized = updateBacklogObjectTriage(store, item, { difficulty: 'xl', criticality: 'low' }, '2026-06-07T06:00:00.000Z')
assert.equal(sized.items[0]?.difficulty, 'xl')
assert.equal(sized.items[0]?.criticality, 'low')
assert.equal(sized.items[0]?.updatedAt, '2026-06-07T06:00:00.000Z')

const clearedSize = updateBacklogObjectTriage(sized, item, { difficulty: null }, '2026-06-07T07:00:00.000Z')
assert.equal(clearedSize.items[0]?.difficulty, undefined)
assert.equal(clearedSize.items[0]?.criticality, 'low')

// Invalid persisted triage values are dropped on normalization (here via an
// unrelated mutation that round-trips the store), while valid ones survive.
const dirty: BacklogObjectStore = {
  schemaVersion: 1,
  items: [
    {
      id: 'item_dirty',
      source: { type: 'file', relativePath: 'backlog/checkout.md' },
      type: 'epic' as unknown as 'feature',
      difficulty: 'huge' as unknown as 'xl',
      criticality: 'high',
    },
  ],
}
const cleaned = updateBacklogObjectStatus(dirty, item, 'idea', '2026-06-07T08:00:00.000Z')
assert.equal(cleaned.items[0]?.type, undefined)
assert.equal(cleaned.items[0]?.difficulty, undefined)
assert.equal(cleaned.items[0]?.criticality, 'high')

const statusUpdated = updateBacklogObjectStatus(store, item, 'completed', '2026-06-07T02:00:00.000Z')
assert.equal(statusUpdated.items[0]?.status, 'completed')
assert.equal(statusUpdated.items[0]?.updatedAt, '2026-06-07T02:00:00.000Z')

const linked = addBacklogObjectLink(store, item, {
  id: 'jira:PROJ-1',
  moduleId: 'jira',
  type: 'issue',
  label: 'Jira issue',
  target: { kind: 'jira.issue', id: 'PROJ-1', url: 'https://example.test/PROJ-1' },
  status: 'active',
}, '2026-06-07T03:00:00.000Z')
assert.equal(linked.items[0]?.links?.length, 2)
assert.equal(linked.items[0]?.links?.[1]?.updatedAt, '2026-06-07T03:00:00.000Z')

const moved = moveBacklogObjectSource(store, item, 'backlog/renamed-checkout.md', '2026-06-07T04:00:00.000Z')
assert.equal(moved.items[0]?.id, 'item_checkout')
assert.equal(moved.items[0]?.source.relativePath, 'backlog/renamed-checkout.md')
assert.equal(moved.items[0]?.status, 'in_progress')

const archived = moveBacklogObjectSource(store, item, 'backlog/archived/checkout.md', '2026-06-07T05:00:00.000Z')
assert.equal(archived.items[0]?.id, 'item_checkout')
assert.equal(archived.items[0]?.status, 'archived')

const removed = removeBacklogObjectRecord(store, item)
assert.equal(removed.items.length, 0)

console.log('backlogObjects.test.ts: ok')
