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

test('a labelled clock re-renders only when a label it draws moves, and reads the latest tick when it does render', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body></body>')
  const globals = globalThis as unknown as Record<string, unknown>
  const previous = { window: globals.window, document: globals.document, act: globals.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globals, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { formatRelativeMs } = await import('../utils/relativeTime')
    const { useRelativeNowFor } = await import('./useRelativeNow')
    vi.setSystemTime(10 * 60_000)
    const clocks = createRelativeNowClocks(fakeActivity().activity)
    let renders = 0
    let drawnNow = 0
    function Row({ idleSince, title }: { idleSince: number; title: string }) {
      const now = useRelativeNowFor((at) => formatRelativeMs(idleSince, at), 30_000, clocks)
      renders++
      drawnNow = now
      return createElement('span', null, `${title} ${formatRelativeMs(idleSince, now)}`)
    }
    const host = dom.window.document.createElement('div')
    const root = createRoot(host)
    // Idle since 2m15s before the clock started: "2m" until 45 s in.
    const idleSince = 10 * 60_000 - 135_000
    act(() => root.render(createElement(Row, { idleSince, title: 'a' })))
    assert.equal(host.textContent, 'a 2m')
    renders = 0

    act(() => void vi.advanceTimersByTime(30_000))
    assert.equal(renders, 0, 'a tick that leaves "2m" as it was renders nothing')
    assert.equal(host.textContent, 'a 2m')

    act(() => void vi.advanceTimersByTime(30_000))
    assert.equal(renders, 1, 'the tick that turns "2m" into "3m" renders once')
    assert.equal(host.textContent, 'a 3m')

    act(() => void vi.advanceTimersByTime(30_000))
    renders = 0
    act(() => root.render(createElement(Row, { idleSince, title: 'b' })))
    assert.equal(
      drawnNow,
      10 * 60_000 + 90_000,
      'a render for another reason reads the latest tick, not the last drawn one',
    )
    assert.equal(host.textContent, 'b 3m')

    act(() => root.unmount())
    assert.equal(vi.getTimerCount(), 0, 'unmounting stops the clock')
  } finally {
    Object.assign(globals, {
      window: previous.window,
      document: previous.document,
      IS_REACT_ACT_ENVIRONMENT: previous.act,
    })
    dom.window.close()
  }
})
