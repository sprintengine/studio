import assert from 'node:assert/strict'

import { createBacklogItem } from './backlog'
import {
  hydrateBacklogScanResult,
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

console.log('backlogObjects.test.ts: ok')
