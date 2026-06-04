import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import {
  WORKSPACE_STALE_THRESHOLD_MS,
  isWorkspaceStale,
  partitionWorkspacesByRecency,
  sortWorkspacesByActivity,
  workspaceLastWorkedAt,
} from './workspaceRecency'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

// Only the recency-relevant fields matter here; the partition never reads the
// rest of the workspace record. Cast at this test boundary keeps the fixtures
// readable without an `any`.
function makeWorkspace(
  id: string,
  fields: { createdAt: number; lastTerminalActivityAt?: number | null }
): Workspace {
  return {
    id,
    createdAt: fields.createdAt,
    lastTerminalActivityAt: fields.lastTerminalActivityAt,
  } as unknown as Workspace
}

run('workspaceLastWorkedAt prefers the most recent of createdAt and last terminal output', () => {
  assert.equal(
    workspaceLastWorkedAt(makeWorkspace('a', { createdAt: NOW - 10 * DAY, lastTerminalActivityAt: NOW - 2 * DAY })),
    NOW - 2 * DAY,
  )
  // A workspace whose only signal is creation falls back to createdAt.
  assert.equal(
    workspaceLastWorkedAt(makeWorkspace('b', { createdAt: NOW - DAY, lastTerminalActivityAt: null })),
    NOW - DAY,
  )
  // Stale terminal activity never drags recency below createdAt.
  assert.equal(
    workspaceLastWorkedAt(makeWorkspace('c', { createdAt: NOW - DAY, lastTerminalActivityAt: NOW - 9 * DAY })),
    NOW - DAY,
  )
})

run('isWorkspaceStale uses the 5-day threshold inclusively', () => {
  assert.equal(isWorkspaceStale(makeWorkspace('fresh', { createdAt: NOW - 4 * DAY }), NOW), false)
  assert.equal(isWorkspaceStale(makeWorkspace('edge', { createdAt: NOW - WORKSPACE_STALE_THRESHOLD_MS }), NOW), true)
  assert.equal(isWorkspaceStale(makeWorkspace('old', { createdAt: NOW - 30 * DAY }), NOW), true)
})

run('partition keeps recent rows and folds stale ones, preserving order', () => {
  const recentA = makeWorkspace('recent-a', { createdAt: NOW - DAY })
  const staleB = makeWorkspace('stale-b', { createdAt: NOW - 10 * DAY })
  const recentC = makeWorkspace('recent-c', { createdAt: NOW - 6 * DAY, lastTerminalActivityAt: NOW - 2 * DAY })
  const staleD = makeWorkspace('stale-d', { createdAt: NOW - 8 * DAY })

  const { recent, stale } = partitionWorkspacesByRecency([recentA, staleB, recentC, staleD], NOW, () => false)

  assert.deepEqual(recent.map((w) => w.id), ['recent-a', 'recent-c'])
  assert.deepEqual(stale.map((w) => w.id), ['stale-b', 'stale-d'])
})

run('pinned workspaces never fold even when stale', () => {
  const pinned = makeWorkspace('pinned', { createdAt: NOW - 30 * DAY })
  const stale = makeWorkspace('stale', { createdAt: NOW - 30 * DAY })

  const partition = partitionWorkspacesByRecency([pinned, stale], NOW, (w) => w.id === 'pinned')

  assert.deepEqual(partition.recent.map((w) => w.id), ['pinned'])
  assert.deepEqual(partition.stale.map((w) => w.id), ['stale'])
})

run('sortWorkspacesByActivity floats live workspaces above idle ones', () => {
  const idleRecent = makeWorkspace('idle-recent', { createdAt: NOW - DAY, lastTerminalActivityAt: NOW - 60_000 })
  const liveStale = makeWorkspace('live-stale', { createdAt: NOW - 30 * DAY })
  const idleOld = makeWorkspace('idle-old', { createdAt: NOW - 20 * DAY })

  const live = new Set(['live-stale'])
  const sorted = sortWorkspacesByActivity(
    [idleRecent, liveStale, idleOld],
    (w) => live.has(w.id),
  )

  // Live row leads despite being the oldest by timestamp; idle rows follow by recency.
  assert.deepEqual(sorted.map((w) => w.id), ['live-stale', 'idle-recent', 'idle-old'])
})

run('sortWorkspacesByActivity sorts idle rows by recency but keeps live rows in stored order', () => {
  // Live rows carry only the status dot and a working agent's last-output time
  // climbs as it streams, so the live tier stays in stored order (no churn);
  // only the idle tier is ordered by how recently each was worked on.
  const liveSecond = makeWorkspace('live-second', { createdAt: NOW - DAY, lastTerminalActivityAt: NOW - 5 * 60_000 })
  const liveFirst = makeWorkspace('live-first', { createdAt: NOW - DAY, lastTerminalActivityAt: NOW - 1_000 })
  const idleA = makeWorkspace('idle-a', { createdAt: NOW - 2 * DAY })
  const idleB = makeWorkspace('idle-b', { createdAt: NOW - DAY })

  const live = new Set(['live-first', 'live-second'])
  const sorted = sortWorkspacesByActivity(
    [liveSecond, idleA, liveFirst, idleB],
    (w) => live.has(w.id),
  )

  // Live rows precede idle ones in their original order; idle rows by recency.
  assert.deepEqual(sorted.map((w) => w.id), ['live-second', 'live-first', 'idle-b', 'idle-a'])
})

run('sortWorkspacesByActivity is stable for exact ties and does not mutate input', () => {
  const a = makeWorkspace('a', { createdAt: NOW })
  const b = makeWorkspace('b', { createdAt: NOW })
  const c = makeWorkspace('c', { createdAt: NOW })
  const input = [a, b, c]

  const sorted = sortWorkspacesByActivity(input, () => false)

  assert.deepEqual(sorted.map((w) => w.id), ['a', 'b', 'c'])
  // Pure: the caller's array is untouched.
  assert.notEqual(sorted, input)
  assert.deepEqual(input.map((w) => w.id), ['a', 'b', 'c'])
})

console.log('workspaceRecency.test.ts: ok')
