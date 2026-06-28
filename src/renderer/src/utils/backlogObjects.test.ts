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
      highlight: { starred: true, color: 'amber' },
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
// Frontmatter is the source of truth for lifecycle/triage: the sidecar record's
// stale status/type/difficulty/criticality no longer override the file. The
// checkout fixture has no frontmatter, so these resolve to their file defaults.
assert.equal(hydrated.items[0]?.status, 'idea')
assert.equal(hydrated.items[0]?.type, undefined)
assert.equal(hydrated.items[0]?.difficulty, undefined)
assert.equal(hydrated.items[0]?.criticality, undefined)
// App churn still merges from the sidecar: links, module metadata, and highlight.
assert.equal(hydrated.items[0]?.links[0]?.target.path, '.multi-code/sprintengine/checkout/run.yaml')
assert.deepEqual(hydrated.items[0]?.metadata, { 'sprint-engine': { lastRunId: 'checkout' } })
assert.equal(item.highlight, undefined)
assert.deepEqual(hydrated.items[0]?.highlight, { starred: true, color: 'amber' })

// Frontmatter wins even when a stale sidecar record disagrees on every axis, and
// epic/isEpic + unknown-type tolerance read straight from frontmatter.
const frontmatterItem = createBacklogItem({
  path: '/repo/backlog/payments.md',
  relativePath: 'backlog/payments.md',
  sourceContent: '---\nstatus: ready\ntype: feature\ndifficulty: s\ncriticality: low\nepic: payments-revamp\n---\n# Payments',
  stats: { modifiedAtMs: 10, sizeBytes: 20 },
})
const staleStore: BacklogObjectStore = {
  schemaVersion: 1,
  items: [
    {
      id: 'item_payments',
      source: { type: 'file', relativePath: 'backlog/payments.md' },
      status: 'completed',
      type: 'bug',
      difficulty: 'xl',
      criticality: 'critical',
      metadata: {},
      links: [],
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
  ],
}
const frontmatterHydrated = hydrateBacklogScanResult(
  { state: 'ready', items: [frontmatterItem], errors: [] },
  staleStore,
)
assert.equal(frontmatterHydrated.items[0]?.status, 'ready')
assert.equal(frontmatterHydrated.items[0]?.type, 'feature')
assert.equal(frontmatterHydrated.items[0]?.difficulty, 's')
assert.equal(frontmatterHydrated.items[0]?.criticality, 'low')
assert.equal(frontmatterHydrated.items[0]?.epic, 'payments-revamp')
assert.equal(frontmatterHydrated.items[0]?.isEpic, false)
assert.equal(frontmatterHydrated.items[0]?.objectId, 'item_payments')

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

// Triage edits set, then clear, an axis; the other axes are untouched. Risk is
// the third axis, plumbed parallel to difficulty/criticality.
const sized = updateBacklogObjectTriage(store, item, { difficulty: 'xl', criticality: 'low', risk: 'high' }, '2026-06-07T06:00:00.000Z')
assert.equal(sized.items[0]?.difficulty, 'xl')
assert.equal(sized.items[0]?.criticality, 'low')
assert.equal(sized.items[0]?.risk, 'high')
assert.equal(sized.items[0]?.updatedAt, '2026-06-07T06:00:00.000Z')

const clearedSize = updateBacklogObjectTriage(sized, item, { difficulty: null }, '2026-06-07T07:00:00.000Z')
assert.equal(clearedSize.items[0]?.difficulty, undefined)
assert.equal(clearedSize.items[0]?.criticality, 'low')
// Omitting risk leaves it untouched; passing null clears it.
assert.equal(clearedSize.items[0]?.risk, 'high')
const clearedRisk = updateBacklogObjectTriage(sized, item, { risk: null }, '2026-06-07T07:30:00.000Z')
assert.equal(clearedRisk.items[0]?.risk, undefined)
assert.equal(clearedRisk.items[0]?.criticality, 'low')

// Invalid persisted triage values are dropped on normalization (here via an
// unrelated mutation that round-trips the store), while valid ones survive.
const dirty: BacklogObjectStore = {
  schemaVersion: 1,
  items: [
    {
      id: 'item_dirty',
      source: { type: 'file', relativePath: 'backlog/checkout.md' },
      type: 'saga' as unknown as 'feature',
      difficulty: 'huge' as unknown as 'xl',
      criticality: 'high',
      risk: 'critical' as unknown as 'high',
      highlight: { starred: true, color: 'magenta' as unknown as 'red' },
    },
  ],
}
const cleaned = updateBacklogObjectStatus(dirty, item, 'idea', '2026-06-07T08:00:00.000Z')
assert.equal(cleaned.items[0]?.type, undefined)
assert.equal(cleaned.items[0]?.difficulty, undefined)
assert.equal(cleaned.items[0]?.criticality, 'high')
// `critical` is not a valid risk value (low|normal|high) and is dropped.
assert.equal(cleaned.items[0]?.risk, undefined)
// Unknown highlight colors are dropped on normalization; the star survives.
assert.deepEqual(cleaned.items[0]?.highlight, { starred: true, color: null })

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
