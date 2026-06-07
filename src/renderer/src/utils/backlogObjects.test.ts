import assert from 'node:assert/strict'

import { createBacklogItem } from './backlog'
import {
  addBacklogObjectLink,
  ensureBacklogObjectRecords,
  hydrateBacklogScanResult,
  moveBacklogObjectSource,
  removeBacklogObjectRecord,
  updateBacklogObjectStatus,
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

const ensured = ensureBacklogObjectRecords({ schemaVersion: 1, items: [] }, [item], '2026-06-07T01:00:00.000Z')
assert.equal(ensured.changed, true)
assert.equal(ensured.store.items[0]?.source.relativePath, 'backlog/checkout.md')
assert.equal(ensured.store.items[0]?.status, 'needs_structure')

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
