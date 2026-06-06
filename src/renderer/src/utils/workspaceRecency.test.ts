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

run('sortWorkspacesByActivity counts live rows as "now", tied with recent idle rows', () => {
  // A green-dot row no longer floats to the top: it joins the same "just now"
  // tier as rows worked within the last 30 minutes and keeps its stored order.
  const idleRecent = makeWorkspace('idle-recent', { createdAt: NOW - 5 * 60_000 })
  const liveStale = makeWorkspace('live-stale', { createdAt: NOW - 30 * DAY })
  const idleOld = makeWorkspace('idle-old', { createdAt: NOW - 2 * DAY })

  const live = new Set(['live-stale'])
  const sorted = sortWorkspacesByActivity(
    [idleRecent, liveStale, idleOld],
    (w) => live.has(w.id),
    NOW,
  )

  // idle-recent precedes the live row (both "now", stored order); the live row
  // does not jump ahead despite its stale timestamp. idle-old trails, outside
  // the window.
  assert.deepEqual(sorted.map((w) => w.id), ['idle-recent', 'live-stale', 'idle-old'])
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
    NOW,
  )

  // Live rows ("now") lead in stored order; the idle rows here are older than
  // the 30-minute window, so they fall below and order by recency.
  assert.deepEqual(sorted.map((w) => w.id), ['live-second', 'live-first', 'idle-b', 'idle-a'])
})

run('sortWorkspacesByActivity treats rows worked within 30 minutes as equally recent', () => {
  // newer/older differ by 10 minutes but both fall inside the 30-minute window,
  // so they must keep stored order instead of reshuffling; olderStill is past
  // the window and sorts below both by its real last-worked time.
  const newer = makeWorkspace('newer', { createdAt: NOW - 2 * 60_000 })
  const older = makeWorkspace('older', { createdAt: NOW - 12 * 60_000 })
  const olderStill = makeWorkspace('older-still', { createdAt: NOW - 90 * 60_000 })

  const sorted = sortWorkspacesByActivity([older, newer, olderStill], () => false, NOW)

  // older precedes newer despite being worked on earlier: both tie inside the
  // window and keep their incoming order. older-still trails, outside the window.
  assert.deepEqual(sorted.map((w) => w.id), ['older', 'newer', 'older-still'])
})

run('sortWorkspacesByActivity orders rows past the 30-minute window by recency', () => {
  const recent = makeWorkspace('recent', { createdAt: NOW - 40 * 60_000 })
  const oldest = makeWorkspace('oldest', { createdAt: NOW - 5 * DAY })
  const middle = makeWorkspace('middle', { createdAt: NOW - DAY })

  const sorted = sortWorkspacesByActivity([oldest, recent, middle], () => false, NOW)

  assert.deepEqual(sorted.map((w) => w.id), ['recent', 'middle', 'oldest'])
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
