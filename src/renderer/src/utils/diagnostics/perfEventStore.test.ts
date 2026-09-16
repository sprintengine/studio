import assert from 'node:assert/strict'
import {
  aggregatePerfEvents,
  percentile,
  type PerfEventSample,
} from './perfEventStore'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = 1_700_000_000_000

function sample(scope: string, event: string, elapsedMs: number | null, recordedAt: number): PerfEventSample {
  return { scope, event, elapsedMs, recordedAt }
}

run('percentile uses nearest-rank and returns null for empty', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([10], 50), 10)
  assert.equal(percentile([1, 2, 3, 4], 50), 2)
  assert.equal(percentile([1, 2, 3, 4], 95), 4)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)
})

run('groups by scope·event and computes p50/p95/max/count', () => {
  const rows = aggregatePerfEvents(
    [
      sample('BacklogScan', 'refresh', 0, NOW - 5),
      sample('BacklogScan', 'refresh', 0, NOW - 4),
      sample('BacklogScan', 'refresh', 40, NOW - 3),
      sample('BacklogScan', 'refresh', 120, NOW - 2),
      sample('AutomationsScheduler', 'tick-end', 8, NOW - 1),
    ],
    { now: NOW }
  )
  const projection = rows.find((row) => row.scope === 'BacklogScan' && row.event === 'refresh')!
  assert.equal(projection.count, 4)
  assert.equal(projection.maxMs, 120)
  // Nearest-rank p50 of [0,0,40,120] is 0 — meaningful here: half the ticks are
  // the free "unchanged" short-circuit, so the median tick costs ~nothing.
  assert.equal(projection.p50Ms, 0)
  assert.equal(projection.p95Ms, 120)
  assert.equal(projection.lastMs, 120, 'last by recordedAt')
})

run('events without elapsedMs still count but contribute no duration', () => {
  const rows = aggregatePerfEvents(
    [
      sample('Scope', 'evt', null, NOW - 2),
      sample('Scope', 'evt', null, NOW - 1),
    ],
    { now: NOW }
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].count, 2)
  assert.equal(rows[0].p50Ms, null)
  assert.equal(rows[0].maxMs, null)
})

run('windowMs drops samples older than the window', () => {
  const rows = aggregatePerfEvents(
    [
      sample('Scope', 'evt', 5, NOW - 90_000),
      sample('Scope', 'evt', 9, NOW - 1_000),
    ],
    { now: NOW, windowMs: 60_000 }
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].count, 1, 'only the in-window sample is counted')
  assert.equal(rows[0].maxMs, 9)
})

run('sorts worst p95 first, then by count', () => {
  const rows = aggregatePerfEvents(
    [
      sample('A', 'cheap', 1, NOW - 3),
      sample('A', 'cheap', 1, NOW - 2),
      sample('B', 'spiky', 500, NOW - 1),
    ],
    { now: NOW }
  )
  assert.equal(rows[0].scope, 'B', 'spiky p95 floats to the top')
})

console.log('perf-event store tests passed')
