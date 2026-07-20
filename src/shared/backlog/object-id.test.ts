import assert from 'node:assert/strict'
import type { BacklogObjectRecordPayload } from '../electron-api'
import {
  normalizeBacklogObjectPath,
  reconcileBacklogObjectRecordIds,
  stableBacklogObjectId,
} from './object-id'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// Independent reference implementations. `stableBacklogObjectId` MUST match the
// FNV-1a reference (the documented contract shared with the /backlog skill) and
// MUST NOT match the retired djb2 variant the main process once used.
function referenceFnv1a(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').toLowerCase()
  let hash = 2166136261
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `backlog_${(hash >>> 0).toString(36)}`
}

function referenceDjb2(relativePath: string): string {
  let hash = 0
  for (let i = 0; i < relativePath.length; i += 1) {
    hash = ((hash << 5) - hash) + relativePath.charCodeAt(i)
    hash |= 0
  }
  return `backlog_${(hash >>> 0).toString(36)}`
}

// Case, backslashes, unicode — the axes called out in the backlog item.
const REPRESENTATIVE_PATHS = [
  'backlog/2026-07-10-backlog-id-divergent-hashes.md',
  'backlog/epics/auth-revamp.md',
  'backlog/MixedCase-Item.md',
  'backlog\\windows\\style\\path.md',
  'backlog/archived/old-idea.md',
  'backlog/café-señor-日本語.md',
]

run('the id is the documented FNV-1a hash, never the retired djb2', () => {
  for (const path of REPRESENTATIVE_PATHS) {
    assert.equal(stableBacklogObjectId(path), referenceFnv1a(path), `FNV mismatch for ${path}`)
    // Guard against a regression back to djb2 (only meaningful where the two
    // hashes actually differ for this input, which they do for real paths).
    if (referenceFnv1a(path) !== referenceDjb2(path)) {
      assert.notEqual(stableBacklogObjectId(path), referenceDjb2(path), `must not be djb2 for ${path}`)
    }
  }
})

run('the id is slash-agnostic and case-insensitive', () => {
  assert.equal(
    stableBacklogObjectId('backlog\\Epics\\Auth-Revamp.md'),
    stableBacklogObjectId('backlog/epics/auth-revamp.md'),
  )
  // Duplicate separators and a leading slash normalize away.
  assert.equal(
    stableBacklogObjectId('/backlog//sub///item.md'),
    stableBacklogObjectId('backlog/sub/item.md'),
  )
})

run('the id is stable (all ids well-formed, no accidental collisions)', () => {
  const ids = REPRESENTATIVE_PATHS.map(stableBacklogObjectId)
  for (const id of ids) assert.match(id, /^backlog_[0-9a-z]+$/)
  assert.equal(new Set(ids).size, ids.length, 'distinct paths must yield distinct ids')
})

run('normalizeBacklogObjectPath preserves case but normalizes separators', () => {
  assert.equal(normalizeBacklogObjectPath('backlog\\A\\B.md'), 'backlog/A/B.md')
  assert.equal(normalizeBacklogObjectPath('//backlog///x.md'), 'backlog/x.md')
})

function record(overrides: Partial<BacklogObjectRecordPayload> & { relativePath: string; id: string }): BacklogObjectRecordPayload {
  const { relativePath, ...rest } = overrides
  return {
    source: { type: 'file', relativePath },
    metadata: {},
    links: [],
    ...rest,
    id: overrides.id,
  }
}

run('reconcile re-keys a djb2-hashed record onto the canonical FNV id', () => {
  const path = 'backlog/lonely.md'
  const djb2Record = record({ relativePath: path, id: referenceDjb2(path) })
  const [reconciled] = reconcileBacklogObjectRecordIds([djb2Record])
  assert.equal(reconciled.id, stableBacklogObjectId(path))
  assert.notEqual(reconciled.id, referenceDjb2(path))
})

run('reconcile leaves a canonical record untouched (idempotent)', () => {
  const path = 'backlog/canonical.md'
  const canonical = record({ relativePath: path, id: stableBacklogObjectId(path) })
  const [once] = reconcileBacklogObjectRecordIds([canonical])
  const [twice] = reconcileBacklogObjectRecordIds([once])
  assert.deepEqual(twice, canonical)
})

run('reconcile merges djb2 + FNV twins: union links, newest updatedAt wins', () => {
  const path = 'backlog/forked.md'
  const djb2Twin = record({
    relativePath: path,
    id: referenceDjb2(path),
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    links: [
      { id: 'agent-runtime:working-agent', moduleId: 'agent-runtime', type: 'agent', label: 'Agent: old', target: { kind: 'agent.terminal', id: 'ws/old' }, updatedAt: '2026-06-01T00:00:00.000Z' },
    ],
    highlight: { starred: true, color: 'red' },
  })
  const fnvTwin = record({
    relativePath: path,
    id: stableBacklogObjectId(path),
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    links: [
      // Same fixed link id, newer timestamp — must supersede the djb2 twin's.
      { id: 'agent-runtime:working-agent', moduleId: 'agent-runtime', type: 'agent', label: 'Agent: new', target: { kind: 'agent.terminal', id: 'ws/new' }, updatedAt: '2026-07-05T00:00:00.000Z' },
      // A distinct link id present only on the FNV twin — must be preserved.
      { id: 'sprint:execution', moduleId: 'sprint', type: 'execution', label: 'Run', target: { kind: 'run', id: 'run-1' }, updatedAt: '2026-07-02T00:00:00.000Z' },
    ],
  })

  const reconciled = reconcileBacklogObjectRecordIds([djb2Twin, fnvTwin])
  assert.equal(reconciled.length, 1, 'twins collapse to one record')
  const merged = reconciled[0]
  assert.equal(merged.id, stableBacklogObjectId(path))
  // Earliest createdAt kept, latest updatedAt kept.
  assert.equal(merged.createdAt, '2026-06-01T00:00:00.000Z')
  assert.equal(merged.updatedAt, '2026-07-05T00:00:00.000Z')
  // Links unioned by id; the working-agent link is the newer copy.
  assert.equal(merged.links?.length, 2)
  const working = merged.links?.find((l) => l.id === 'agent-runtime:working-agent')
  assert.equal(working?.label, 'Agent: new')
  assert.ok(merged.links?.some((l) => l.id === 'sprint:execution'), 'distinct link preserved')
  // Newer record has no highlight; the older starred highlight survives.
  assert.deepEqual(merged.highlight, { starred: true, color: 'red' })
})

run('reconcile order independence: same merge regardless of input order', () => {
  const path = 'backlog/order.md'
  const a = record({ relativePath: path, id: referenceDjb2(path), updatedAt: '2026-06-01T00:00:00.000Z', metadata: { a: 1 } })
  const b = record({ relativePath: path, id: stableBacklogObjectId(path), updatedAt: '2026-07-01T00:00:00.000Z', metadata: { b: 2 } })
  const [ab] = reconcileBacklogObjectRecordIds([a, b])
  const [ba] = reconcileBacklogObjectRecordIds([b, a])
  assert.deepEqual(ab, ba)
  assert.deepEqual(ab.metadata, { a: 1, b: 2 })
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('object-id.test.ts: ok')
}

main()
