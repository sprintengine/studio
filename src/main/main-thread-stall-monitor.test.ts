import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createMainThreadStallMonitor, type MainThreadStallReport } from './main-thread-stall-monitor'

function harness(options: { reportEveryMs?: number } = {}) {
  let clock = 0
  let tick: (() => void) | null = null
  const reports: MainThreadStallReport[] = []
  const monitor = createMainThreadStallMonitor({
    report: (report) => reports.push(report),
    now: () => clock,
    timers: {
      setInterval: (handler) => {
        tick = handler
        return 1
      },
      clearInterval: () => {
        tick = null
      },
    },
    intervalMs: 500,
    thresholdMs: 1_000,
    reportEveryMs: options.reportEveryMs ?? 60_000,
  })
  // Advance the clock by `elapsedMs` and fire the heartbeat once, the way a
  // loop that was busy for that long would.
  const beat = (elapsedMs: number) => {
    clock += elapsedMs
    tick?.()
  }
  // Advance the clock without a heartbeat: time the process spent asleep.
  const sleep = (elapsedMs: number) => {
    clock += elapsedMs
  }
  return { monitor, reports, beat, sleep, running: () => tick !== null }
}

test('a healthy loop reports nothing', () => {
  const { monitor, reports, beat } = harness()
  monitor.start()
  for (let index = 0; index < 20; index += 1) beat(500 + (index % 3) * 40)
  monitor.stop()
  assert.deepEqual(reports, [])
})

test('the first stall after a quiet spell is reported at once', () => {
  const { monitor, reports, beat } = harness()
  monitor.start()
  beat(500)
  beat(3_000)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].stalls, 1)
  assert.equal(reports[0].maxStallMs, 2_500)
  assert.equal(reports[0].totalStallMs, 2_500)
})

test('stalls that keep coming are rolled up into one report per window', () => {
  const { monitor, reports, beat } = harness({ reportEveryMs: 10_000 })
  monitor.start()
  beat(2_000) // stall of 1500, reported at once
  beat(1_700) // 1200
  beat(3_500) // 3000
  beat(500)
  assert.equal(reports.length, 1, 'the later stalls wait for the window')
  beat(4_500) // 4000, and the window has now elapsed
  assert.equal(reports.length, 2)
  assert.deepEqual(
    { stalls: reports[1].stalls, maxStallMs: reports[1].maxStallMs, totalStallMs: reports[1].totalStallMs },
    { stalls: 3, maxStallMs: 4_000, totalStallMs: 8_200 },
  )
})

test('stop writes what is pending and releases the timer', () => {
  const { monitor, reports, beat, running } = harness()
  monitor.start()
  beat(2_000)
  beat(2_000)
  assert.equal(reports.length, 1)
  monitor.stop()
  assert.equal(reports.length, 2)
  assert.equal(reports[1].stalls, 1)
  assert.equal(running(), false)
})

test('a reporter that throws does not stop the heartbeat', () => {
  let clock = 0
  const heartbeat: { tick: (() => void) | null } = { tick: null }
  let calls = 0
  const monitor = createMainThreadStallMonitor({
    report: () => {
      calls += 1
      throw new Error('disk full')
    },
    now: () => clock,
    timers: {
      setInterval: (handler) => {
        heartbeat.tick = handler
        return 1
      },
      clearInterval: () => {},
    },
    reportEveryMs: 0,
  })
  monitor.start()
  clock += 5_000
  assert.doesNotThrow(() => heartbeat.tick?.())
  clock += 5_000
  heartbeat.tick?.()
  assert.equal(calls, 2)
})

test('a wake from sleep re-arms the baseline instead of reporting the nap as a stall', () => {
  const { monitor, reports, beat, sleep } = harness()
  monitor.start()
  beat(500)
  // The machine slept for an hour with the heartbeat armed. The wake handler
  // resets before the first late tick lands.
  sleep(60 * 60_000)
  monitor.reset()
  beat(500)
  assert.deepEqual(reports, [])

  // The same hour without the reset is exactly what the reset is for.
  sleep(60 * 60_000)
  beat(500)
  assert.equal(reports.length, 1)
  assert.equal(monitor.isRunning(), true)
  monitor.stop()
  assert.equal(monitor.isRunning(), false)
})
