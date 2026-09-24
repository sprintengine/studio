import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { WindowActivity, WindowActivityState } from '../utils/windowActivity'
import { createRelativeNowClocks } from './useRelativeNow'

function fakeActivity(initial: WindowActivityState = { visible: true, focused: true }) {
  let state = initial
  const listeners = new Set<(state: WindowActivityState) => void>()
  const activity: WindowActivity = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    dispose: () => listeners.clear(),
  }
  const set = (next: WindowActivityState): void => {
    state = next
    for (const listener of [...listeners]) listener(state)
  }
  return { activity, set }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('one shared clock ticks on its interval while the window can be seen', () => {
  const { activity } = fakeActivity()
  const clocks = createRelativeNowClocks(activity)
  const a: number[] = []
  const b: number[] = []
  const stopA = clocks.subscribe(1_000, (now) => a.push(now))
  const stopB = clocks.subscribe(1_000, (now) => b.push(now))
  vi.advanceTimersByTime(3_000)
  assert.equal(a.length, 3)
  assert.equal(b.length, 3)
  assert.equal(vi.getTimerCount(), 1, 'one timer for every caller on the same interval')
  stopA()
  stopB()
  assert.equal(vi.getTimerCount(), 0, 'the last unsubscribe stops it')
})

test('the clock stops while the window is minimized, even with the page saying visible, and catches up on show', () => {
  // The window-activity state folds in main's minimize signal: a page that
  // still reports itself visible is exactly the macOS case this is for.
  const { activity, set } = fakeActivity()
  const clocks = createRelativeNowClocks(activity)
  const ticks: number[] = []
  const stop = clocks.subscribe(1_000, (now) => ticks.push(now))

  set({ visible: false, focused: false })
  assert.equal(vi.getTimerCount(), 0, 'no timer while nobody can see the window')
  vi.advanceTimersByTime(10_000)
  assert.equal(ticks.length, 0)

  set({ visible: true, focused: false })
  assert.equal(ticks.length, 1, 'shown again: reads the time at once')
  assert.equal(ticks[0], Date.now())
  vi.advanceTimersByTime(1_000)
  assert.equal(ticks.length, 2, 'and ticks again')
  stop()
})

test('a focus change alone neither stops nor restarts the clock', () => {
  const { activity, set } = fakeActivity()
  const clocks = createRelativeNowClocks(activity)
  const ticks: number[] = []
  const stop = clocks.subscribe(1_000, (now) => ticks.push(now))
  set({ visible: true, focused: false })
  set({ visible: true, focused: true })
  assert.equal(ticks.length, 0, 'no extra tick for a focus change')
  vi.advanceTimersByTime(1_000)
  assert.equal(ticks.length, 1)
  stop()
})

test('a subscriber arriving while the window is hidden starts no timer until it is shown', () => {
  const { activity, set } = fakeActivity({ visible: false, focused: false })
  const clocks = createRelativeNowClocks(activity)
  const ticks: number[] = []
  const stop = clocks.subscribe(1_000, (now) => ticks.push(now))
  assert.equal(vi.getTimerCount(), 0)
  set({ visible: true, focused: true })
  assert.equal(ticks.length, 1)
  assert.equal(vi.getTimerCount(), 1)
  stop()
})
