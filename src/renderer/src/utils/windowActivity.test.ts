import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  bindWindowActivityAttribute,
  createWindowActivity,
  isWindowVisible,
  onWindowVisibilityChange,
  type WindowActivityState,
} from './windowActivity'

function fakeWindow() {
  const docListeners = new Set<() => void>()
  const winListeners = new Map<string, Set<() => void>>()
  const deferred: Array<() => void> = []
  const env = {
    visibilityState: 'visible' as DocumentVisibilityState,
    focused: true,
  }
  const doc = {
    get visibilityState() {
      return env.visibilityState
    },
    hasFocus: () => env.focused,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => void docListeners.add(listener),
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => void docListeners.delete(listener),
  }
  const win = {
    addEventListener: (type: 'focus' | 'blur', listener: () => void) => {
      const set = winListeners.get(type) ?? new Set()
      set.add(listener)
      winListeners.set(type, set)
    },
    removeEventListener: (type: 'focus' | 'blur', listener: () => void) =>
      void winListeners.get(type)?.delete(listener),
    setTimeout: (handler: () => void) => {
      deferred.push(handler)
      return deferred.length
    },
  }
  const fire = (type: 'focus' | 'blur' | 'visibilitychange') => {
    const listeners = type === 'visibilitychange' ? docListeners : (winListeners.get(type) ?? new Set())
    for (const listener of [...listeners]) listener()
  }
  const runDeferred = () => {
    for (const handler of deferred.splice(0)) handler()
  }
  const listenerCount = () => docListeners.size + [...winListeners.values()].reduce((sum, set) => sum + set.size, 0)
  return { env, doc, win, fire, runDeferred, listenerCount }
}

test('visibility and focus are tracked, and blur is read after focus settles', () => {
  const fake = fakeWindow()
  const activity = createWindowActivity(fake.doc, fake.win)
  const seen: WindowActivityState[] = []
  activity.subscribe((state) => seen.push(state))
  assert.deepEqual(activity.get(), { visible: true, focused: true })

  // Focus moving into the browser pane's guest blurs this document, but the
  // window still has focus: nothing changes.
  fake.fire('blur')
  fake.runDeferred()
  assert.deepEqual(seen, [])

  fake.env.focused = false
  fake.fire('blur')
  assert.deepEqual(seen, [], 'not read in the blur itself')
  fake.runDeferred()
  assert.deepEqual(seen, [{ visible: true, focused: false }])

  fake.env.visibilityState = 'hidden'
  fake.fire('visibilitychange')
  assert.deepEqual(seen.at(-1), { visible: false, focused: false })

  fake.env.visibilityState = 'visible'
  fake.env.focused = true
  fake.fire('visibilitychange')
  assert.deepEqual(seen.at(-1), { visible: true, focused: true })

  activity.dispose()
  assert.equal(fake.listenerCount(), 0)
})

test('the root attribute pauses motion while hidden or in the background', () => {
  const fake = fakeWindow()
  const activity = createWindowActivity(fake.doc, fake.win)
  const root = { dataset: {} as DOMStringMap }
  const unbind = bindWindowActivityAttribute(root, activity)
  assert.equal(root.dataset['windowActive'], 'true')

  fake.env.focused = false
  fake.fire('blur')
  fake.runDeferred()
  assert.equal(root.dataset['windowActive'], 'false')

  fake.env.focused = true
  fake.fire('focus')
  assert.equal(root.dataset['windowActive'], 'true')

  fake.env.visibilityState = 'hidden'
  fake.fire('visibilitychange')
  assert.equal(root.dataset['windowActive'], 'false', 'a hidden window is never active, whatever hasFocus says')

  unbind()
  fake.env.visibilityState = 'visible'
  fake.fire('visibilitychange')
  assert.equal(root.dataset['windowActive'], 'false', 'unbound')
})

test("main's minimize / lock signal hides the window even when the page still says visible", () => {
  const fake = fakeWindow()
  let push: ((hidden: boolean) => void) | null = null
  const activity = createWindowActivity(fake.doc, fake.win, (listener) => {
    push = listener
    return () => {
      push = null
    }
  })
  assert.equal(activity.get().visible, true)
  push!(true)
  assert.deepEqual(activity.get(), { visible: false, focused: false }, 'macOS: minimized, page still "visible"')
  push!(false)
  assert.equal(activity.get().visible, true)
  activity.dispose()
  assert.equal(push, null, 'unsubscribed on dispose')
})

test('paused work hears only visibility changes, including the ones only main can see', () => {
  const fake = fakeWindow()
  let push: ((hidden: boolean) => void) | null = null
  const activity = createWindowActivity(fake.doc, fake.win, (listener) => {
    push = listener
    return () => {
      push = null
    }
  })
  const seen: boolean[] = []
  const unbind = onWindowVisibilityChange((visible) => seen.push(visible), activity)
  assert.equal(isWindowVisible(activity), true)

  // Clicking into another app leaves the window on screen: nothing to resume or pause.
  fake.env.focused = false
  fake.fire('blur')
  fake.runDeferred()
  fake.env.focused = true
  fake.fire('focus')
  assert.deepEqual(seen, [], 'focus changes alone are not reported')

  // macOS minimize: the page still says visible; main says hidden.
  push!(true)
  assert.equal(fake.doc.visibilityState, 'visible')
  assert.equal(isWindowVisible(activity), false, 'a minimized window is not visible, whatever the page says')
  assert.deepEqual(seen, [false])
  push!(false)
  assert.deepEqual(seen, [false, true])

  // The page's own signal still counts.
  fake.env.visibilityState = 'hidden'
  fake.fire('visibilitychange')
  assert.deepEqual(seen, [false, true, false])

  unbind()
  fake.env.visibilityState = 'visible'
  fake.fire('visibilitychange')
  assert.deepEqual(seen, [false, true, false], 'unbound')
  activity.dispose()
})
