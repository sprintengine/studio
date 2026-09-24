import assert from 'node:assert/strict'

import {
  POLLER_BATTERY_STRETCH,
  POLLER_FEED_INTERVAL_MS,
  POLLER_FOCUS_UPDATE_AFTER_MS,
  POLLER_WAKE_OFFLINE_RETRIES,
  POLLER_WAKE_OFFLINE_RETRY_MS,
  POLLER_WAKE_SETTLE_MS,
  POLLER_FIRST_TICK_MS,
  POLLER_UPDATE_INTERVAL_MS,
  createHostedFeedPoller,
} from './poller'
import { test } from 'vitest'

test('poller', async () => {
  type Timer = { at: number; handler: () => void; id: number }

  function fakeClock() {
    let now = 0
    let nextId = 1
    const timers: Timer[] = []
    const setTimer = (handler: () => void, ms: number): unknown => {
      const timer = { at: now + ms, handler, id: nextId++ }
      timers.push(timer)
      return timer.id
    }
    const clearTimer = (handle: unknown): void => {
      const index = timers.findIndex((timer) => timer.id === handle)
      if (index !== -1) timers.splice(index, 1)
    }
    // Advance in steps, running every timer that comes due, and yielding to the
    // microtask queue so a leg's promise chain settles before the next timer.
    const advance = async (ms: number): Promise<void> => {
      const target = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > target) break
        now = next.at
        timers.shift()
        next.handler()
        for (let i = 0; i < 5; i += 1) await Promise.resolve()
      }
      now = target
    }
    return { setTimer, clearTimer, advance, pending: () => timers.length, now: () => now }
  }

  async function main(): Promise<void> {
    // The schedule: feed and versions at 15 s, updates an hour in, then repeats.
    {
      const clock = fakeClock()
      const calls: string[] = []
      const poller = createHostedFeedPoller({
        checkUpdates: async () => void calls.push(`updates@${clock.now()}`),
        refreshFeed: async () => void calls.push(`feed@${clock.now()}`),
        refreshVersions: async () => void calls.push(`versions@${clock.now()}`),
        setTimer: clock.setTimer,
        now: clock.now,
        clearTimer: clock.clearTimer,
        random: () => 0.5,
      })
      poller.start()
      await clock.advance(POLLER_FIRST_TICK_MS - 1)
      assert.deepEqual(calls.slice(), [], 'nothing before the first tick')
      await clock.advance(1)
      assert.deepEqual(calls.sort(), [`feed@${POLLER_FIRST_TICK_MS}`, `versions@${POLLER_FIRST_TICK_MS}`])
      await clock.advance(POLLER_UPDATE_INTERVAL_MS - POLLER_FIRST_TICK_MS)
      assert.ok(
        calls.includes(`updates@${POLLER_UPDATE_INTERVAL_MS}`),
        'the update leg waits a full interval (the boot leg already checked)',
      )
      assert.equal(POLLER_UPDATE_INTERVAL_MS, 60 * 60_000, 'updates are hourly, not every few minutes')
      await clock.advance(POLLER_UPDATE_INTERVAL_MS)
      assert.ok(calls.includes(`updates@${2 * POLLER_UPDATE_INTERVAL_MS}`), 'updates repeat hourly')
      assert.equal(
        calls.filter((c) => c.startsWith('feed@')).length,
        2,
        'the feed leg repeats hourly (jitter 0 at random 0.5)',
      )
      assert.equal(calls.filter((c) => c.startsWith('updates@')).length, 2, 'two update checks in two hours')
      poller.stop()
      assert.equal(clock.pending(), 0, 'stop clears every timer')
      const before = calls.length
      await clock.advance(POLLER_FEED_INTERVAL_MS * 2)
      assert.equal(calls.length, before, 'nothing runs after stop')
    }

    // Offline skips a tick and keeps the rhythm; no overlap while a leg is pending.
    {
      const clock = fakeClock()
      let online = false
      let feedRuns = 0
      let release: (() => void) | null = null
      const poller = createHostedFeedPoller({
        checkUpdates: async () => {},
        refreshFeed: () =>
          new Promise<void>((resolve) => {
            feedRuns += 1
            release = resolve
          }),
        refreshVersions: async () => {},
        isOnline: () => online,
        setTimer: clock.setTimer,
        now: clock.now,
        clearTimer: clock.clearTimer,
        random: () => 0.5,
      })
      poller.start()
      await clock.advance(POLLER_FIRST_TICK_MS)
      assert.equal(feedRuns, 0, 'offline: the tick is skipped')
      online = true
      await clock.advance(POLLER_FEED_INTERVAL_MS)
      assert.equal(feedRuns, 1, 'back online: the next tick runs')
      const manual = poller.run('feed')
      assert.equal(feedRuns, 1, 'a manual run joins the in-flight leg instead of overlapping it')
      release!()
      await manual
      const second = poller.run('feed')
      assert.equal(feedRuns, 2)
      release!()
      await second
      poller.stop()
    }

    // A failing leg is reported and does not stop the schedule.
    {
      const clock = fakeClock()
      const errors: string[] = []
      let versions = 0
      const poller = createHostedFeedPoller({
        checkUpdates: async () => {},
        refreshFeed: async () => {
          throw new Error('boom')
        },
        refreshVersions: async () => void (versions += 1),
        setTimer: clock.setTimer,
        now: clock.now,
        clearTimer: clock.clearTimer,
        random: () => 0.5,
        onError: (leg, error) => errors.push(`${leg}:${(error as Error).message}`),
      })
      poller.start()
      await clock.advance(POLLER_FIRST_TICK_MS)
      assert.deepEqual(errors, ['feed:boom'])
      await clock.advance(POLLER_FEED_INTERVAL_MS)
      assert.deepEqual(errors, ['feed:boom', 'feed:boom'], 'the failing leg is retried on schedule')
      assert.equal(versions, 2, 'the other legs are unaffected')
      poller.stop()
    }

    // Sleep: nothing runs while suspended; waking checks for an update and
    // brings overdue legs back shortly after, once the network has settled.
    {
      const clock = fakeClock()
      const calls: string[] = []
      const poller = createHostedFeedPoller({
        checkUpdates: async () => void calls.push(`updates@${clock.now()}`),
        refreshFeed: async () => void calls.push(`feed@${clock.now()}`),
        refreshVersions: async () => void calls.push(`versions@${clock.now()}`),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        now: clock.now,
        random: () => 0.5,
      })
      poller.start()
      poller.suspend()
      assert.equal(clock.pending(), 0, 'a sleeping machine holds no poller timers')
      await clock.advance(3 * POLLER_FEED_INTERVAL_MS)
      assert.equal(calls.length, 0, 'nothing ran while suspended')
      poller.wake()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
      assert.deepEqual(calls, [], 'the instant of waking, when the network is usually still down, runs nothing')
      const wokeAt = clock.now()
      await clock.advance(POLLER_WAKE_SETTLE_MS)
      const settled = wokeAt + POLLER_WAKE_SETTLE_MS
      assert.deepEqual(
        calls.slice().sort(),
        [`feed@${settled}`, `updates@${settled}`, `versions@${settled}`],
        'the update check and the overdue legs run once, shortly after waking',
      )
      await clock.advance(POLLER_UPDATE_INTERVAL_MS - 1)
      assert.equal(calls.filter((c) => c.startsWith('updates@')).length, 1)
      await clock.advance(1)
      assert.equal(
        calls.filter((c) => c.startsWith('updates@')).length,
        2,
        'the wake check restarted the update interval from when it ran',
      )
      poller.stop()
    }

    // Waking offline: the update check retries on a short cadence until the
    // network is back, instead of skipping itself and waiting an hour.
    {
      const clock = fakeClock()
      let online = false
      const checks: number[] = []
      const poller = createHostedFeedPoller({
        checkUpdates: async () => void checks.push(clock.now()),
        refreshFeed: async () => {},
        refreshVersions: async () => {},
        isOnline: () => online,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        now: clock.now,
        random: () => 0.5,
      })
      poller.start()
      poller.suspend()
      await clock.advance(3 * POLLER_UPDATE_INTERVAL_MS)
      poller.wake()
      const wokeAt = clock.now()
      await clock.advance(POLLER_WAKE_SETTLE_MS + 2 * POLLER_WAKE_OFFLINE_RETRY_MS)
      assert.deepEqual(checks, [], 'still offline: nothing ran')
      online = true
      await clock.advance(POLLER_WAKE_OFFLINE_RETRY_MS)
      assert.deepEqual(
        checks,
        [wokeAt + POLLER_WAKE_SETTLE_MS + 3 * POLLER_WAKE_OFFLINE_RETRY_MS],
        'the first retry that finds the network checks',
      )
      await clock.advance(POLLER_UPDATE_INTERVAL_MS - 1)
      assert.equal(checks.length, 1, 'then back to the hourly rhythm, not the retry cadence')
      poller.stop()
    }

    // A wake that stays offline gives up after its retries and keeps the rhythm.
    {
      const clock = fakeClock()
      let online = false
      let checks = 0
      const poller = createHostedFeedPoller({
        checkUpdates: async () => void (checks += 1),
        refreshFeed: async () => {},
        refreshVersions: async () => {},
        isOnline: () => online,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        now: clock.now,
        random: () => 0.5,
      })
      poller.start()
      poller.wake()
      const retriesEndAt = POLLER_WAKE_SETTLE_MS + POLLER_WAKE_OFFLINE_RETRIES * POLLER_WAKE_OFFLINE_RETRY_MS
      await clock.advance(retriesEndAt)
      online = true
      await clock.advance(POLLER_UPDATE_INTERVAL_MS - 1)
      assert.equal(checks, 0, 'the retries are bounded; the next check is an interval after the last one')
      await clock.advance(1)
      assert.equal(checks, 1)
      poller.stop()
    }

    // Focus after a long absence checks for an update; a quick return does not.
    {
      const clock = fakeClock()
      let checks = 0
      const poller = createHostedFeedPoller({
        checkUpdates: async () => void (checks += 1),
        refreshFeed: async () => {},
        refreshVersions: async () => {},
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        now: clock.now,
        random: () => 0.5,
      })
      poller.start()
      await clock.advance(POLLER_FOCUS_UPDATE_AFTER_MS - 1)
      poller.noteFocus()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
      assert.equal(checks, 0, 'the boot check is still fresh')
      await clock.advance(1)
      poller.noteFocus()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
      assert.equal(checks, 1, 'half an hour away: coming back checks')
      poller.noteFocus()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
      assert.equal(checks, 1, 'a second focus right after does not')
      await clock.advance(POLLER_UPDATE_INTERVAL_MS - 1)
      assert.equal(checks, 1, 'the hourly check restarted from the focus check')
      await clock.advance(1)
      assert.equal(checks, 2)
      poller.stop()
    }

    // Battery stretches every wait, including the one already running.
    {
      const clock = fakeClock()
      let checks = 0
      const poller = createHostedFeedPoller({
        checkUpdates: async () => void (checks += 1),
        refreshFeed: async () => {},
        refreshVersions: async () => {},
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        now: clock.now,
        random: () => 0.5,
      })
      poller.start()
      await clock.advance(POLLER_UPDATE_INTERVAL_MS / 2)
      poller.setOnBattery(true)
      await clock.advance((POLLER_UPDATE_INTERVAL_MS / 2) * POLLER_BATTERY_STRETCH - 1)
      assert.equal(checks, 0, 'the remaining half hour became two hours')
      await clock.advance(1)
      assert.equal(checks, 1)
      await clock.advance(POLLER_UPDATE_INTERVAL_MS * POLLER_BATTERY_STRETCH - 1)
      assert.equal(checks, 1, 'on battery the next interval is stretched too')
      poller.setOnBattery(false)
      await clock.advance(1)
      assert.equal(checks, 2, 'back on power: what was left shrinks back')
      poller.stop()
    }

    console.log('hosted-feed poller: ok')
  }

  // A test that awaits a promise nobody resolves lets node exit 0 with nothing
  // printed. Refuse that: the run is a pass only when main() reached its end.
  let finished = false
  process.on('exit', (code) => {
    if (!finished && code === 0) {
      console.error('hosted-feed poller: main() did not finish')
      process.exitCode = 1
    }
  })
  const suiteRun = main()
    .then(() => {
      finished = true
    })
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })

  await suiteRun
})
