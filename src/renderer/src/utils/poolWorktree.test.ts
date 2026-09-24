import assert from 'node:assert/strict'
import { test } from 'vitest'

import { normalizeWorktreeEntry, releaseWorktreeEntriesOwnedBy } from '../store/slices/worktreesSlice'
import type { WorkspaceWorktreeState } from '../types/workspace'
import { worktreeIdFromPath } from './workspaceWorktree'

test('a pooled worktree id carries its lease, so two leases of one slot never share an id', () => {
  const slot = '/Users/dev/.sprintengine-worktrees/app/pool-03'
  const first = worktreeIdFromPath(slot, '2f1c7c1e-aaaa-4bbb-8ccc-000000000001')
  const second = worktreeIdFromPath(slot, '2f1c7c1e-aaaa-4bbb-8ccc-000000000002')
  assert.notEqual(first, second)
  assert.ok(first.startsWith(worktreeIdFromPath(slot)))
  // A worktree that is not a pool slot keeps the id it always had.
  assert.equal(worktreeIdFromPath(slot), 'worktree-users-dev-sprintengine-worktrees-app-pool-03')
  assert.equal(worktreeIdFromPath(slot, null), worktreeIdFromPath(slot))
  // Windows spelling: separators and the drive colon never reach the id.
  assert.doesNotMatch(worktreeIdFromPath('C:\\Users\\dev\\.sprintengine-worktrees\\app\\pool-01', 'x'), /[\\/:]/)
})

test('releasing an agent drops its pooled entries and keeps its ordinary ones', () => {
  const now = 1_000
  const pooled = normalizeWorktreeEntry({
    id: 'pooled',
    path: '/Users/dev/.sprintengine-worktrees/app/pool-01',
    branch: 'agent/a',
    ownerAgentId: 'agent-1',
    status: 'assigned',
    leaseId: 'lease-1',
  })
  const plain = normalizeWorktreeEntry({
    id: 'plain',
    path: '/Users/dev/.sprintengine-worktrees/app/fix',
    branch: 'agent/fix',
    ownerAgentId: 'agent-1',
    status: 'assigned',
  })
  assert.ok(pooled && plain)
  assert.equal(pooled.leaseId, 'lease-1', 'the lease survives normalization')
  const state: WorkspaceWorktreeState = { containerPath: null, entries: { pooled, plain }, updatedAt: null }
  const workspace = { worktreeState: state }
  assert.equal(releaseWorktreeEntriesOwnedBy(workspace, 'agent-1', now), 2)
  assert.equal(state.entries.pooled, undefined)
  assert.equal(state.entries.plain?.status, 'available')
  assert.equal(state.entries.plain?.ownerAgentId, null)
})
