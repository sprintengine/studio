import assert from 'node:assert/strict'
import {
  computeRetainedWorkspaceLayoutIds,
  WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT,
  WORKSPACE_LAYOUT_IDLE_UNLOAD_MS,
  WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT,
} from './workspaceLayoutRetention'

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
assert.equal(
  compute({
    mountedWorkspaceIds: ['active', 'removed'],
    visibleWorkspaceIds: ['active'],
    lastFocusedAtByWorkspaceId: {
      active: NOW,
      removed: NOW,
    },
  }).evicted[0]?.reason,
  'not-visible',
)

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
assert.equal(
  compute({
    mountedWorkspaceIds: ['active', 'recent', 'quiet-a', 'quiet-b'],
    visibleWorkspaceIds: ['active', 'recent', 'quiet-a', 'quiet-b'],
    lastFocusedAtByWorkspaceId: {
      active: NOW,
      recent: NOW - 1 * MINUTE,
      'quiet-a': NOW - 2 * MINUTE,
      'quiet-b': NOW - 3 * MINUTE,
    },
    inactiveLimit: 1,
  }).evicted.find((entry) => entry.workspaceId === 'quiet-a')?.reason,
  'inactive-limit',
)

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
assert.equal(
  compute({
    mountedWorkspaceIds: ['active', 'busy-a', 'busy-b'],
    visibleWorkspaceIds: ['active', 'busy-a', 'busy-b'],
    busyWorkspaceIds: new Set(['busy-a', 'busy-b']),
    lastFocusedAtByWorkspaceId: {
      active: NOW,
      'busy-a': NOW - 10 * MINUTE,
      'busy-b': NOW - 11 * MINUTE,
    },
    busyLimit: 1,
  }).evicted.find((entry) => entry.workspaceId === 'busy-b')?.reason,
  'busy-limit',
)

assertRetained(['active'], {
  mountedWorkspaceIds: ['active', 'older'],
})
assert.equal(
  compute({
    mountedWorkspaceIds: ['active', 'older'],
  }).evicted.find((entry) => entry.workspaceId === 'older')?.reason,
  'expired',
)

// --- Production tuning (2026-06-13 progressive replay / retention) ---

// Guard the shipped policy values so the memory tradeoff stays explicit.
assert.equal(WORKSPACE_LAYOUT_IDLE_UNLOAD_MS, 60 * MINUTE)
assert.equal(WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT, 4)
assert.equal(WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT, 10)

// At the production one-hour idle window, a layout idle for 45 minutes (which
// expired under the old 30-minute window) is still retained, while one idle
// past the hour expires.
assertRetained(['active', 'older'], {
  mountedWorkspaceIds: ['active', 'older'],
  visibleWorkspaceIds: ['active', 'older'],
  lastFocusedAtByWorkspaceId: {
    active: NOW,
    older: NOW - 45 * MINUTE,
  },
  idleUnloadMs: WORKSPACE_LAYOUT_IDLE_UNLOAD_MS,
})
assert.equal(
  compute({
    mountedWorkspaceIds: ['active', 'stale'],
    visibleWorkspaceIds: ['active', 'stale'],
    lastFocusedAtByWorkspaceId: {
      active: NOW,
      stale: NOW - 65 * MINUTE,
    },
    idleUnloadMs: WORKSPACE_LAYOUT_IDLE_UNLOAD_MS,
  }).evicted.find((entry) => entry.workspaceId === 'stale')?.reason,
  'expired',
)

// The production busy cap of 10 retains the ten most-recently-focused busy
// layouts and evicts the eleventh by busy-limit.
{
  const busyIds = Array.from({ length: 11 }, (_, index) => `busy-${index}`)
  const mountedWorkspaceIds = ['active', ...busyIds]
  const lastFocusedAtByWorkspaceId: Record<string, number> = { active: NOW }
  busyIds.forEach((id, index) => {
    // busy-0 is most recent; busy-10 is least recent and should be evicted.
    lastFocusedAtByWorkspaceId[id] = NOW - (index + 1) * MINUTE
  })
  const input = {
    mountedWorkspaceIds,
    visibleWorkspaceIds: mountedWorkspaceIds,
    busyWorkspaceIds: new Set(busyIds),
    lastFocusedAtByWorkspaceId,
    busyLimit: WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT,
  }
  const result = compute(input)
  assert.equal(result.retainedWorkspaceIds.length, 1 + WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT)
  assert.equal(result.retainedWorkspaceIds.includes('busy-10'), false)
  assert.equal(result.evicted.find((entry) => entry.workspaceId === 'busy-10')?.reason, 'busy-limit')
}

console.log('workspaceLayoutRetention.test.ts: ok')
