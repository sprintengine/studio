import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import {
  WORKSPACE_STALE_THRESHOLD_MS,
  isWorkspaceStale,
  keepLaterWorkspaceClocks,
  partitionWorkspacesByRecency,
  sortWorkspacesByActivity,
  sortWorkspacesByAttention,
  workspaceLastWorkedAt,
  type WorkspaceAttentionTier,
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
  fields: { createdAt?: number; lastTerminalActivityAt?: number | null; lastTurnEndedAt?: number | null }
): Workspace {
  return {
    id,
    createdAt: fields.createdAt ?? NOW - 30 * DAY,
    lastTerminalActivityAt: fields.lastTerminalActivityAt,
    lastTurnEndedAt: fields.lastTurnEndedAt,
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

run('isWorkspaceStale uses the 2-day threshold inclusively', () => {
  assert.equal(isWorkspaceStale(makeWorkspace('fresh', { createdAt: NOW - DAY }), NOW), false)
  assert.equal(isWorkspaceStale(makeWorkspace('edge', { createdAt: NOW - WORKSPACE_STALE_THRESHOLD_MS }), NOW), true)
  assert.equal(isWorkspaceStale(makeWorkspace('old', { createdAt: NOW - 30 * DAY }), NOW), true)
})

run('partition keeps recent rows and folds stale ones, preserving order', () => {
  const recentA = makeWorkspace('recent-a', { createdAt: NOW - DAY })
  const staleB = makeWorkspace('stale-b', { createdAt: NOW - 10 * DAY })
  const recentC = makeWorkspace('recent-c', { createdAt: NOW - 6 * DAY, lastTerminalActivityAt: NOW - DAY })
  const staleD = makeWorkspace('stale-d', { createdAt: NOW - 8 * DAY })

  const { recent, stale } = partitionWorkspacesByRecency([recentA, staleB, recentC, staleD], NOW, () => false)

  assert.deepEqual(recent.map((w) => w.id), ['recent-a', 'recent-c'])
  assert.deepEqual(stale.map((w) => w.id), ['stale-b', 'stale-d'])
})

run('partition caps the at-rest rows and folds the overflow ahead of stale rows', () => {
  // Six recent rows with a cap of 4: the first four stay, the newer overflow
  // rows lead the fold so paging reads in recency order, and genuinely stale
  // rows trail. A pinned row never counts against the cap.
  const recents = Array.from({ length: 6 }, (_, i) =>
    makeWorkspace(`recent-${i}`, { createdAt: NOW - (i + 1) * 60_000 }),
  )
  const staleRow = makeWorkspace('stale', { createdAt: NOW - 10 * DAY })
  const pinned = makeWorkspace('pinned', { createdAt: NOW - 30 * DAY })

  const { recent, stale } = partitionWorkspacesByRecency(
    [...recents, staleRow, pinned],
    NOW,
    (w) => w.id === 'pinned',
    4,
  )

  assert.deepEqual(
    recent.map((w) => w.id),
    ['recent-0', 'recent-1', 'recent-2', 'recent-3', 'pinned'],
  )
  assert.deepEqual(stale.map((w) => w.id), ['recent-4', 'recent-5', 'stale'])
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

run('sortWorkspacesByAttention bands blocked, then done, then running, then at rest', () => {
  const resting = makeWorkspace('resting', { createdAt: NOW })
  const running = makeWorkspace('running', { createdAt: NOW })
  const done = makeWorkspace('done', { createdAt: NOW })
  const attention = makeWorkspace('attention', { createdAt: NOW })
  const tiers: Record<string, WorkspaceAttentionTier> = {
    resting: 'resting',
    running: 'running',
    done: 'done',
    attention: 'attention',
  }

  const sorted = sortWorkspacesByAttention(
    [resting, running, done, attention],
    (workspace) => tiers[workspace.id],
    NOW
  )

  assert.deepEqual(sorted.map((w) => w.id), ['attention', 'done', 'running', 'resting'])
})

run('sortWorkspacesByAttention keeps recency order inside a band', () => {
  // All four rows are at rest, so the band never separates them and the
  // existing recency comparator decides the whole list.
  const recent = makeWorkspace('recent', { createdAt: NOW - 40 * 60_000 })
  const middle = makeWorkspace('middle', { createdAt: NOW - DAY })
  const oldest = makeWorkspace('oldest', { createdAt: NOW - 5 * DAY })

  const sorted = sortWorkspacesByAttention([oldest, recent, middle], () => 'resting', NOW)

  assert.deepEqual(sorted.map((w) => w.id), ['recent', 'middle', 'oldest'])
})

run('sortWorkspacesByAttention lifts a stale blocked row above a fresh resting one', () => {
  // The point of the banding: a row that wants you outranks a row you touched
  // more recently, which recency alone could never express.
  const fresh = makeWorkspace('fresh', { createdAt: NOW })
  const staleBlocked = makeWorkspace('stale-blocked', { createdAt: NOW - 5 * DAY })

  const sorted = sortWorkspacesByAttention(
    [fresh, staleBlocked],
    (workspace) => (workspace.id === 'stale-blocked' ? 'attention' : 'resting'),
    NOW
  )

  assert.deepEqual(sorted.map((w) => w.id), ['stale-blocked', 'fresh'])
})

run('sortWorkspacesByAttention is stable within a band and does not mutate input', () => {
  const a = makeWorkspace('a', { createdAt: NOW })
  const b = makeWorkspace('b', { createdAt: NOW })
  const c = makeWorkspace('c', { createdAt: NOW })
  const input = [a, b, c]

  const sorted = sortWorkspacesByAttention(input, () => 'running', NOW)

  assert.deepEqual(sorted.map((w) => w.id), ['a', 'b', 'c'])
  assert.notEqual(sorted, input)
  assert.deepEqual(input.map((w) => w.id), ['a', 'b', 'c'])
})

console.log('workspaceRecency.test.ts: ok')

run('keepLaterWorkspaceClocks never rolls an activity clock back', () => {
  const existing = makeWorkspace('w', { lastTerminalActivityAt: NOW - DAY, lastTurnEndedAt: NOW - 2 * DAY })
  const older = makeWorkspace('w', { lastTerminalActivityAt: NOW - 3 * DAY, lastTurnEndedAt: null })
  const merged = keepLaterWorkspaceClocks(existing, older)
  assert.equal(merged.lastTerminalActivityAt, NOW - DAY, 'the later input clock wins')
  assert.equal(merged.lastTurnEndedAt, NOW - 2 * DAY, 'an absent incoming clock keeps the known one')
  assert.notEqual(merged, older, 'a merge is a new object')

  const newer = makeWorkspace('w', { lastTerminalActivityAt: NOW, lastTurnEndedAt: NOW })
  assert.equal(keepLaterWorkspaceClocks(existing, newer), newer, 'a newer record passes through untouched')
  assert.equal(keepLaterWorkspaceClocks(makeWorkspace('w', {}), older), older, 'nothing known, nothing kept')
})

console.log('workspaceRecency.test.ts: ok')
