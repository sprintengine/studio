import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorktreePoolSlotView, WorktreePoolSnapshot } from '../../../../shared/electron-api'
import { formatBytes, poolSummary, slotGlyph, slotMeta } from './worktreePoolView'

const now = 10_000_000

function slot(overrides: Partial<WorktreePoolSlotView>): WorktreePoolSlotView {
  return {
    id: 'pool-01',
    path: '/Users/dev/.sprintengine-worktrees/app/pool-01',
    state: 'warm',
    baseRef: 'origin/main',
    baseSha: 'a'.repeat(40),
    refreshedAt: now - 4 * 60_000,
    depsState: 'ok',
    installCommand: 'npm ci',
    error: null,
    lease: null,
    held: null,
    sizeBytes: 1.2 * 1024 ** 3,
    lastUsedAt: null,
    ...overrides,
  }
}

test('slot lines say what a person needs and nothing else', () => {
  assert.equal(slotMeta(slot({}), now, null), 'warm · refreshed 4 min ago · 1.2 GB')
  assert.equal(slotGlyph(slot({})), null, 'a warm slot earns no glyph')

  const failed = slot({ depsState: 'failed' })
  assert.match(slotMeta(failed, now, null), /npm ci failed/)
  assert.equal(slotGlyph(failed)?.state, 'failed')

  const leased = slot({
    state: 'leased',
    lease: { leaseId: 'l', branch: 'agent/x', owner: { agentId: 'agent-1', workspaceId: 'ws' }, leasedAt: now },
  })
  assert.equal(slotMeta(leased, now, 'Ada Lovelace'), 'leased to Ada Lovelace · 1.2 GB')

  const held = slot({
    state: 'held',
    held: { reason: 'dirty', detail: null, changedPaths: 3, branch: 'agent/x', since: now },
  })
  assert.equal(slotMeta(held, now, null), 'held: uncommitted changes · 3 changed · agent/x · 1.2 GB')
  assert.equal(slotGlyph(held)?.state, 'needs_input')
  assert.equal(slotGlyph(slot({ state: 'installing' }))?.state, 'in_progress')
  assert.equal(formatBytes(null), null)
  assert.equal(formatBytes(512), '512 B')
})

test('the pool summary counts only the states it has', () => {
  const snapshot: WorktreePoolSnapshot = {
    poolId: 'p',
    repoRoot: '/Users/dev/app',
    containerPath: '/Users/dev/.sprintengine-worktrees/app',
    fsHost: 'local',
    platform: 'darwin',
    disabled: false,
    heldByOtherInstance: false,
    defaultRef: 'origin/main',
    lastFetchAt: null,
    lastLeaseAt: null,
    slots: [slot({}), slot({ id: 'pool-02', state: 'held' }), slot({ id: 'pool-03', state: 'installing' })],
  }
  assert.equal(poolSummary(snapshot), '1 warm · 1 preparing · 1 held')
  assert.equal(poolSummary({ ...snapshot, slots: [], disabled: true }), 'off for this repository')
})
