import assert from 'node:assert/strict'

import {
  POLLER_FEED_INTERVAL_MS,
  POLLER_FIRST_TICK_MS,
  POLLER_UPDATE_INTERVAL_MS,
  createHostedFeedPoller,
} from './poller'

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
  // The schedule: feed and versions at 15 s, updates at 4 min, then repeats.
  {
    const clock = fakeClock()
    const calls: string[] = []
    const poller = createHostedFeedPoller({
      checkUpdates: async () => void calls.push(`updates@${clock.now()}`),
      refreshFeed: async () => void calls.push(`feed@${clock.now()}`),
      refreshVersions: async () => void calls.push(`versions@${clock.now()}`),
      setTimer: clock.setTimer,
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
    await clock.advance(POLLER_UPDATE_INTERVAL_MS)
    assert.ok(calls.includes(`updates@${2 * POLLER_UPDATE_INTERVAL_MS}`), 'updates repeat every four minutes')
    await clock.advance(POLLER_FEED_INTERVAL_MS)
    assert.equal(
      calls.filter((c) => c.startsWith('feed@')).length,
      2,
      'the feed leg repeats hourly (jitter 0 at random 0.5)',
    )
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
main()
  .then(() => {
    finished = true
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
