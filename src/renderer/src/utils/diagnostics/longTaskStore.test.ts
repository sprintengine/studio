import assert from 'node:assert/strict'
import { summarizeLongTasks, type LongTaskSample } from './longTaskStore'

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

function task(durationMs: number, recordedAt: number): LongTaskSample {
  return { durationMs, recordedAt }
}

run('empty input summarizes to zeroes with null max/p95', () => {
  const summary = summarizeLongTasks([], { now: NOW })
  assert.equal(summary.count, 0)
  assert.equal(summary.totalMs, 0)
  assert.equal(summary.totalBlockingMs, 0)
  assert.equal(summary.maxMs, null)
  assert.equal(summary.p95Ms, null)
  assert.equal(summary.lastAt, null)
})

run('computes count, total, blocking-time, max, p95', () => {
  const summary = summarizeLongTasks(
    [task(60, NOW - 3), task(120, NOW - 2), task(700, NOW - 1)],
    { now: NOW }
  )
  assert.equal(summary.count, 3)
  assert.equal(summary.totalMs, 880)
  // blocking = (60-50)+(120-50)+(700-50) = 10+70+650 = 730
  assert.equal(summary.totalBlockingMs, 730)
  assert.equal(summary.maxMs, 700)
  assert.equal(summary.p95Ms, 700)
  assert.equal(summary.lastAt, NOW - 1)
})

run('windowMs excludes stale tasks', () => {
  const summary = summarizeLongTasks(
    [task(500, NOW - 120_000), task(80, NOW - 1_000)],
    { now: NOW, windowMs: 60_000 }
  )
  assert.equal(summary.count, 1)
  assert.equal(summary.maxMs, 80)
  assert.equal(summary.totalBlockingMs, 30)
})

console.log('long-task store tests passed')
