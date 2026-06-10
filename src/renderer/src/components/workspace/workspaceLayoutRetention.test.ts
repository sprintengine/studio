import assert from 'node:assert/strict'
import { computeRetainedWorkspaceLayoutIds } from './workspaceLayoutRetention'

const MINUTE = 60_000
const NOW = 1_000_000
const DEFAULT_INPUT = {
  visibleWorkspaceIds: ['active', 'recent', 'older', 'busy'],
  activeWorkspaceId: 'active',
  mountedWorkspaceIds: ['active', 'recent', 'older', 'busy'],
  busyWorkspaceIds: new Set<string>(),
  lastFocusedAtByWorkspaceId: {
    active: NOW,
    recent: NOW - 5 * MINUTE,
    older: NOW - 45 * MINUTE,
    busy: NOW - 60 * MINUTE,
  } as Record<string, number>,
  now: NOW,
  idleUnloadMs: 30 * MINUTE,
  inactiveLimit: 4,
  busyLimit: 8,
}

function compute(input: Partial<typeof DEFAULT_INPUT> = {}) {
  return computeRetainedWorkspaceLayoutIds({
    ...DEFAULT_INPUT,
    ...input,
  })
}

function assertRetained(ids: string[], input: Partial<typeof DEFAULT_INPUT> = {}) {
  assert.deepEqual(compute(input).retainedWorkspaceIds, ids)
}

assertRetained(['active', 'recent'], {
  mountedWorkspaceIds: ['active', 'recent', 'older'],
})

assertRetained(['active'], {
  mountedWorkspaceIds: ['active', 'removed'],
  visibleWorkspaceIds: ['active'],
  lastFocusedAtByWorkspaceId: {
    active: NOW,
    removed: NOW,
  },
})
assert.equal(compute({
  mountedWorkspaceIds: ['active', 'removed'],
  visibleWorkspaceIds: ['active'],
  lastFocusedAtByWorkspaceId: {
    active: NOW,
    removed: NOW,
  },
}).evicted[0]?.reason, 'not-visible')

assertRetained(['active', 'recent'], {
  mountedWorkspaceIds: ['active', 'recent', 'quiet-a', 'quiet-b'],
  visibleWorkspaceIds: ['active', 'recent', 'quiet-a', 'quiet-b'],
  lastFocusedAtByWorkspaceId: {
    active: NOW,
    recent: NOW - 1 * MINUTE,
    'quiet-a': NOW - 2 * MINUTE,
    'quiet-b': NOW - 3 * MINUTE,
  },
  inactiveLimit: 1,
})
assert.equal(compute({
  mountedWorkspaceIds: ['active', 'recent', 'quiet-a', 'quiet-b'],
  visibleWorkspaceIds: ['active', 'recent', 'quiet-a', 'quiet-b'],
  lastFocusedAtByWorkspaceId: {
    active: NOW,
    recent: NOW - 1 * MINUTE,
    'quiet-a': NOW - 2 * MINUTE,
    'quiet-b': NOW - 3 * MINUTE,
  },
  inactiveLimit: 1,
}).evicted.find((entry) => entry.workspaceId === 'quiet-a')?.reason, 'inactive-limit')

assertRetained(['active', 'busy'], {
  busyWorkspaceIds: new Set(['busy']),
  inactiveLimit: 0,
})

assertRetained(['active', 'busy-a'], {
  mountedWorkspaceIds: ['active', 'busy-a', 'busy-b'],
  visibleWorkspaceIds: ['active', 'busy-a', 'busy-b'],
  busyWorkspaceIds: new Set(['busy-a', 'busy-b']),
  lastFocusedAtByWorkspaceId: {
    active: NOW,
    'busy-a': NOW - 10 * MINUTE,
    'busy-b': NOW - 11 * MINUTE,
  },
  busyLimit: 1,
})
assert.equal(compute({
  mountedWorkspaceIds: ['active', 'busy-a', 'busy-b'],
  visibleWorkspaceIds: ['active', 'busy-a', 'busy-b'],
  busyWorkspaceIds: new Set(['busy-a', 'busy-b']),
  lastFocusedAtByWorkspaceId: {
    active: NOW,
    'busy-a': NOW - 10 * MINUTE,
    'busy-b': NOW - 11 * MINUTE,
  },
  busyLimit: 1,
}).evicted.find((entry) => entry.workspaceId === 'busy-b')?.reason, 'busy-limit')

assertRetained(['active'], {
  mountedWorkspaceIds: ['active', 'older'],
})
assert.equal(compute({
  mountedWorkspaceIds: ['active', 'older'],
}).evicted.find((entry) => entry.workspaceId === 'older')?.reason, 'expired')

console.log('workspaceLayoutRetention.test.ts: ok')
