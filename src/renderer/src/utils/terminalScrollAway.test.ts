import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  isTerminalScrolledAway,
  watchTerminalScrolledAway,
  type TerminalScrollAwayTerminal,
} from './terminalScrollAway'

type Listener = (value?: unknown) => void

// A terminal reduced to what the watch reads: a mutable active buffer and four
// events the test fires by hand, each counting its live listeners so disposal
// can be checked.
function fakeTerminal() {
  const listeners = {
    scroll: new Set<Listener>(),
    writeParsed: new Set<Listener>(),
    resize: new Set<Listener>(),
    bufferChange: new Set<Listener>(),
  }
  const event =
    (set: Set<Listener>) =>
    (listener: Listener): { dispose: () => void } => {
      set.add(listener)
      return { dispose: () => set.delete(listener) }
    }
  const active = { type: 'normal' as 'normal' | 'alternate', viewportY: 0, baseY: 0 }
  const terminal = {
    buffer: { active, onBufferChange: event(listeners.bufferChange) },
    onScroll: event(listeners.scroll),
    onWriteParsed: event(listeners.writeParsed),
    onResize: event(listeners.resize),
  } as unknown as TerminalScrollAwayTerminal
  const fire = (name: keyof typeof listeners) => {
    for (const listener of [...listeners[name]]) listener()
  }
  const liveListeners = () => Object.values(listeners).reduce((sum, set) => sum + set.size, 0)
  return { terminal, active, fire, liveListeners }
}

test('a viewport following the output is not scrolled away', () => {
  assert.equal(isTerminalScrolledAway({ type: 'normal', viewportY: 120, baseY: 120 }), false)
  assert.equal(isTerminalScrolledAway({ type: 'normal', viewportY: 0, baseY: 0 }), false)
})

test('a viewport above the bottom page is scrolled away', () => {
  assert.equal(isTerminalScrolledAway({ type: 'normal', viewportY: 40, baseY: 120 }), true)
  assert.equal(isTerminalScrolledAway({ type: 'normal', viewportY: 119, baseY: 120 }), true)
})

test('the alternate screen never counts, whatever its numbers say', () => {
  assert.equal(isTerminalScrolledAway({ type: 'alternate', viewportY: 0, baseY: 10 }), false)
})

test('the watch reports a flip once, not every event that confirms it', () => {
  const { terminal, active, fire } = fakeTerminal()
  const seen: boolean[] = []
  const watch = watchTerminalScrolledAway(terminal, (away) => seen.push(away))

  // Output arriving while the viewport follows it: nothing to report.
  active.baseY = 50
  active.viewportY = 50
  fire('writeParsed')
  fire('scroll')
  assert.deepEqual(seen, [])

  // The person scrolls up.
  active.viewportY = 10
  fire('scroll')
  assert.deepEqual(seen, [true])

  // More output piles up below them — still away, still one report.
  active.baseY = 80
  fire('writeParsed')
  fire('writeParsed')
  assert.deepEqual(seen, [true])

  // They scroll back down.
  active.viewportY = 80
  fire('scroll')
  assert.deepEqual(seen, [true, false])
  watch.dispose()
})

test('a clear that drops the scrollback brings the viewport back without a scroll', () => {
  const { terminal, active, fire } = fakeTerminal()
  const seen: boolean[] = []
  watchTerminalScrolledAway(terminal, (away) => seen.push(away))
  active.baseY = 80
  active.viewportY = 20
  fire('scroll')
  active.baseY = 0
  active.viewportY = 0
  fire('writeParsed')
  assert.deepEqual(seen, [true, false])
})

test('switching to the alternate screen hides the control, and back shows it again', () => {
  const { terminal, active, fire } = fakeTerminal()
  const seen: boolean[] = []
  watchTerminalScrolledAway(terminal, (away) => seen.push(away))
  active.baseY = 80
  active.viewportY = 20
  fire('resize')
  assert.deepEqual(seen, [true])

  active.type = 'alternate'
  fire('bufferChange')
  assert.deepEqual(seen, [true, false])

  active.type = 'normal'
  fire('bufferChange')
  assert.deepEqual(seen, [true, false, true])
})

test('dispose removes every listener the watch added', () => {
  const { terminal, active, fire, liveListeners } = fakeTerminal()
  const seen: boolean[] = []
  const watch = watchTerminalScrolledAway(terminal, (away) => seen.push(away))
  assert.equal(liveListeners(), 4)
  watch.dispose()
  assert.equal(liveListeners(), 0)
  active.baseY = 80
  fire('scroll')
  assert.deepEqual(seen, [])
})
