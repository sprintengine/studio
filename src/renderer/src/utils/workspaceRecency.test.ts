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

run('opening a long-idle workspace does not change its sort position', () => {
  // The bug: opening an idle row flipped it "live" and jumped it to the top.
  // Ordering now keys purely on last-worked time, which opening never touches —
  // so a row last worked two days ago stays exactly where its timestamp puts it,
  // below the rows worked more recently, even though it is the one being opened.
  // This is stale by days, so no widening of the 30-minute tie window could
  // explain the row staying put; only decoupling order from live status does.
  const recent = makeWorkspace('recent', { createdAt: NOW - 5 * 60_000 })
  const openedStale = makeWorkspace('opened-stale', { createdAt: NOW - 2 * DAY })
  const oldest = makeWorkspace('oldest', { createdAt: NOW - 30 * DAY })

  const sorted = sortWorkspacesByActivity([recent, openedStale, oldest], NOW)

  assert.deepEqual(sorted.map((w) => w.id), ['recent', 'opened-stale', 'oldest'])
})

run('typing in a workspace still surfaces it (recency tracks real work)', () => {
  // Genuine work — terminal input bumping lastTerminalActivityAt — pulls a row
  // into the "just now" tier even when it was created long ago, so the list
  // still auto-surfaces recently-worked workspaces.
  const worked = makeWorkspace('worked', { createdAt: NOW - 30 * DAY, lastTerminalActivityAt: NOW - 60_000 })
  const idleRecent = makeWorkspace('idle-recent', { createdAt: NOW - 3 * 60_000 })
  const idleOld = makeWorkspace('idle-old', { createdAt: NOW - 5 * DAY })

  const sorted = sortWorkspacesByActivity([idleOld, worked, idleRecent], NOW)

  // worked and idle-recent both fall inside the 30-minute window → "now" tier,
  // kept in stored order; idle-old trails by its real last-worked time.
  assert.deepEqual(sorted.map((w) => w.id), ['worked', 'idle-recent', 'idle-old'])
})

run('sortWorkspacesByActivity treats rows worked within 30 minutes as equally recent', () => {
  // newer/older differ by 10 minutes but both fall inside the 30-minute window,
  // so they must keep stored order instead of reshuffling; olderStill is past
  // the window and sorts below both by its real last-worked time.
  const newer = makeWorkspace('newer', { createdAt: NOW - 2 * 60_000 })
  const older = makeWorkspace('older', { createdAt: NOW - 12 * 60_000 })
  const olderStill = makeWorkspace('older-still', { createdAt: NOW - 90 * 60_000 })

  const sorted = sortWorkspacesByActivity([older, newer, olderStill], NOW)

  // older precedes newer despite being worked on earlier: both tie inside the
  // window and keep their incoming order. older-still trails, outside the window.
  assert.deepEqual(sorted.map((w) => w.id), ['older', 'newer', 'older-still'])
})

run('sortWorkspacesByActivity orders rows past the 30-minute window by recency', () => {
  const recent = makeWorkspace('recent', { createdAt: NOW - 40 * 60_000 })
  const oldest = makeWorkspace('oldest', { createdAt: NOW - 5 * DAY })
  const middle = makeWorkspace('middle', { createdAt: NOW - DAY })

  const sorted = sortWorkspacesByActivity([oldest, recent, middle], NOW)

  assert.deepEqual(sorted.map((w) => w.id), ['recent', 'middle', 'oldest'])
})

run('sortWorkspacesByActivity is stable for exact ties and does not mutate input', () => {
  const a = makeWorkspace('a', { createdAt: NOW })
  const b = makeWorkspace('b', { createdAt: NOW })
  const c = makeWorkspace('c', { createdAt: NOW })
  const input = [a, b, c]

  const sorted = sortWorkspacesByActivity(input)

  assert.deepEqual(sorted.map((w) => w.id), ['a', 'b', 'c'])
  // Pure: the caller's array is untouched.
  assert.notEqual(sorted, input)
  assert.deepEqual(input.map((w) => w.id), ['a', 'b', 'c'])
})

console.log('workspaceRecency.test.ts: ok')
