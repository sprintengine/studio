import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import {
  WORKSPACE_STALE_THRESHOLD_MS,
  isWorkspaceStale,
  partitionWorkspacesByRecency,
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

console.log('workspaceRecency.test.ts: ok')
