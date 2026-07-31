import assert from 'node:assert/strict'

import { BOOT_REVEAL_TIMEOUT_MS, createBootReveal } from './boot-reveal'

// A controllable clock: the timeout path is the whole reason this module exists,
// and a test that actually waits 10s would never be run.
function fakeTimers() {
  let pending: { handler: () => void; ms: number } | null = null
  let cleared = 0
  return {
    timers: {
      setTimer: (handler: () => void, ms: number) => {
        pending = { handler, ms }
        return 'handle'
      },
      clearTimer: () => {
        cleared += 1
        pending = null
      },
    },
    fire: (): void => {
      assert.ok(pending, 'expected a pending timer to fire')
      const handler = pending.handler
      pending = null
      handler()
    },
    get scheduledMs(): number | null {
      return pending?.ms ?? null
    },
    get clearedCount(): number {
      return cleared
    },
    get isPending(): boolean {
      return pending !== null
    },
  }
}

// The renderer path: the signal reveals, and the armed timeout is cleared so it
// cannot fire a second reveal into a window that is already up.
{
  const clock = fakeTimers()
  let reveals = 0
  const boot = createBootReveal({ reveal: () => (reveals += 1), timers: clock.timers })

  assert.equal(reveals, 0, 'nothing is revealed before a trigger')
  assert.equal(clock.scheduledMs, BOOT_REVEAL_TIMEOUT_MS, 'the timeout is armed at creation, not lazily')
  assert.equal(boot.revealed, false)

  boot.trigger()
  assert.equal(reveals, 1, 'the renderer signal reveals')
  assert.equal(boot.revealed, true)
  assert.equal(clock.clearedCount, 1, 'the timeout is disarmed once the reveal has happened')
  assert.equal(clock.isPending, false)
}

// Reveal-once: repeat signals are a no-op. A renderer that reloads mid-boot, or
// a render-process-gone landing after a successful reveal, must not re-run it.
{
  const clock = fakeTimers()
  let reveals = 0
  const boot = createBootReveal({ reveal: () => (reveals += 1), timers: clock.timers })

  boot.trigger()
  boot.trigger()
  boot.trigger()
  assert.equal(reveals, 1, 'reveal runs exactly once however many triggers arrive')
}

// The timeout path: a renderer that never reports its first frame must still get
// the main window on screen. Without this the always-on-top splash sits over a
// permanently hidden window and Force Quit is the only way out.
{
  const clock = fakeTimers()
  let reveals = 0
  const boot = createBootReveal({ reveal: () => (reveals += 1), timers: clock.timers, timeoutMs: 250 })

  assert.equal(clock.scheduledMs, 250, 'the timeout is overridable')
  clock.fire()
  assert.equal(reveals, 1, 'the timeout reveals on its own')
  assert.equal(boot.revealed, true)
}

// A late signal after the timeout already revealed is a no-op, not a second
// show/focus that would steal focus from whatever the user did in the meantime.
{
  const clock = fakeTimers()
  let reveals = 0
  const boot = createBootReveal({ reveal: () => (reveals += 1), timers: clock.timers })

  clock.fire()
  boot.trigger()
  assert.equal(reveals, 1, 'a signal arriving after the timeout does not reveal again')
}

console.log('boot-reveal tests passed')
