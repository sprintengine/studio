import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createMotionClock, MOTION_TICK_MS, type MotionDocument } from './motionClock'
import type { WindowActivity, WindowActivityState } from './windowActivity'

type FakeAnimation = Animation & { advanced: number[] }

function cssAnimation(
  name: string,
  options: { iterations?: number; target?: { playState?: string; names?: string } } = {},
): FakeAnimation {
  const target = {
    style: {
      animationName: options.target?.names ?? name,
      animationPlayState: options.target?.playState ?? 'running',
    },
  }
  const animation = {
    animationName: name,
    playState: 'running',
    currentTime: 1000,
    advanced: [] as number[],
    effect: {
      target,
      pseudoElement: null,
      getComputedTiming: () => ({ iterations: options.iterations ?? Infinity }),
    },
    pause() {
      this.playState = 'paused'
    },
  }
  let currentTime = animation.currentTime
  Object.defineProperty(animation, 'currentTime', {
    get: () => currentTime,
    set: (value: number) => {
      animation.advanced.push(value - currentTime)
      currentTime = value
    },
  })
  return animation as unknown as FakeAnimation
}

function fakeDocument(animations: Animation[]) {
  const listeners = new Set<() => void>()
  const doc: MotionDocument & { animations: Animation[]; startAnimation(animation: Animation): void } = {
    animations,
    getAnimations: () => doc.animations,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    defaultView: {
      getComputedStyle: (element) => (element as unknown as { style: CSSStyleDeclaration }).style,
    },
    startAnimation(animation) {
      doc.animations = [...doc.animations, animation]
      for (const listener of listeners) listener()
    },
  }
  return doc
}

function fakeActivity(initial: WindowActivityState) {
  let state = initial
  const listeners = new Set<(state: WindowActivityState) => void>()
  const activity: WindowActivity & { set(next: WindowActivityState): void } = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => listeners.clear(),
    set(next) {
      state = next
      for (const listener of listeners) listener(state)
    },
  }
  return activity
}

function fakeTimers() {
  let now = 0
  let next: { handler: () => void; ms: number; id: number } | null = null
  let ids = 0
  return {
    setInterval(handler: () => void, ms: number) {
      next = { handler, ms, id: ++ids }
      return next.id
    },
    clearInterval(id: unknown) {
      if (next?.id === id) next = null
    },
    now: () => now,
    defer: (task: () => void) => queueMicrotask(task),
    get running() {
      return next !== null
    },
    advance(ms: number) {
      now += ms
      next?.handler()
    },
  }
}

const ACTIVE = { visible: true, focused: true }

// A wake runs once the burst of events that caused it is over.
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

test('a loop is caught paused where it stands, then advanced by real time on each tick', async () => {
  const loop = cssAnimation('working-mark-orbit')
  const doc = fakeDocument([loop])
  const timers = fakeTimers()
  const clock = createMotionClock(doc, fakeActivity(ACTIVE), timers)
  await settle()
  assert.equal(loop.playState, 'paused')
  assert.equal(loop.currentTime, 1000, 'caught, not advanced: it was running on its own until now')
  timers.advance(MOTION_TICK_MS)
  timers.advance(MOTION_TICK_MS + 7)
  assert.deepEqual(loop.advanced, [MOTION_TICK_MS, MOTION_TICK_MS + 7])
  clock.dispose()
})

test('an entrance or any finite animation is left to play at full rate', async () => {
  const entrance = cssAnimation('toast-enter', { iterations: 1 })
  const doc = fakeDocument([entrance])
  const timers = fakeTimers()
  const clock = createMotionClock(doc, fakeActivity(ACTIVE), timers)
  await settle()
  assert.equal(entrance.playState, 'running')
  assert.equal(timers.running, false, 'nothing loops, so no timer runs')
  clock.dispose()
})

test('a script animation is not a CSS loop and is left alone', async () => {
  const scripted = cssAnimation('x') as unknown as Record<string, unknown>
  delete scripted['animationName']
  const doc = fakeDocument([scripted as unknown as Animation])
  const timers = fakeTimers()
  const clock = createMotionClock(doc, fakeActivity(ACTIVE), timers)
  await settle()
  assert.equal((scripted as unknown as Animation).playState, 'running')
  clock.dispose()
})

test('a loop the stylesheet holds paused is left alone, and the clock rests until the stylesheet lets it go', async () => {
  const offscreen = cssAnimation('chat-shimmer-sweep', { target: { playState: 'paused' } })
  const doc = fakeDocument([offscreen])
  const timers = fakeTimers()
  let release: () => void = () => undefined
  const clock = createMotionClock(doc, fakeActivity(ACTIVE), timers, (wake) => {
    release = wake
    return () => undefined
  })
  await settle()
  assert.equal(offscreen.playState, 'running', 'the stylesheet has it; the clock does not take it over')
  assert.equal(timers.running, false, 'nothing is free to move, so no timer wakes the window')
  const style = (offscreen.effect as KeyframeEffect).target as unknown as { style: { animationPlayState: string } }
  style.style.animationPlayState = 'running'
  release()
  await settle()
  assert.equal(offscreen.playState, 'paused', 'caught as soon as the stylesheet lets it go')
  assert.equal(timers.running, true)
  timers.advance(MOTION_TICK_MS)
  assert.deepEqual(offscreen.advanced, [MOTION_TICK_MS])
  clock.dispose()
})

test('a sweep reads every loop’s play state before it writes to any', async () => {
  const log: string[] = []
  const loops = ['a', 'b', 'c'].map((name) => {
    const loop = cssAnimation(name)
    const target = (loop.effect as KeyframeEffect).target as unknown as { style: Record<string, string> }
    const style = target.style
    target.style = new Proxy(style, {
      get: (object, key) => {
        if (key === 'animationPlayState') log.push(`read ${name}`)
        return object[key as string]
      },
    })
    const pause = loop.pause.bind(loop)
    loop.pause = () => {
      log.push(`write ${name}`)
      pause()
    }
    return loop
  })
  const clock = createMotionClock(fakeDocument(loops), fakeActivity(ACTIVE), fakeTimers())
  await settle()
  assert.deepEqual(log, ['read a', 'read b', 'read c', 'write a', 'write b', 'write c'])
  clock.dispose()
})

test('a burst of loops starting at once is one sweep, not one per loop', async () => {
  const doc = fakeDocument([])
  let sweeps = 0
  const getAnimations = doc.getAnimations
  doc.getAnimations = () => {
    sweeps++
    return getAnimations()
  }
  const timers = fakeTimers()
  const clock = createMotionClock(doc, fakeActivity(ACTIVE), timers)
  await settle()
  sweeps = 0
  for (let cell = 0; cell < 9; cell++) doc.startAnimation(cssAnimation('working-mark-orbit'))
  await settle()
  assert.equal(sweeps, 1)
  assert.ok(doc.animations.every((loop) => loop.playState === 'paused'))
  clock.dispose()
})

test('the play state is read for the loop’s own entry when an element runs two animations', async () => {
  const loop = cssAnimation('working-edge-orbit', {
    target: { names: 'working-edge-in, working-edge-orbit', playState: 'running, paused' },
  })
  const doc = fakeDocument([loop])
  const timers = fakeTimers()
  const clock = createMotionClock(doc, fakeActivity(ACTIVE), timers)
  await settle()
  assert.equal(loop.playState, 'running', 'its own entry says paused, so the stylesheet has it')
  clock.dispose()
})

test('the clock stops while the window is in the background and resumes when it is back', async () => {
  const loop = cssAnimation('agent-glyph-nod')
  const doc = fakeDocument([loop])
  const timers = fakeTimers()
  const activity = fakeActivity(ACTIVE)
  const clock = createMotionClock(doc, activity, timers)
  await settle()
  timers.advance(MOTION_TICK_MS)
  activity.set({ visible: true, focused: false })
  assert.equal(timers.running, false)
  assert.equal(loop.playState, 'paused', 'held on the frame it reached')
  activity.set(ACTIVE)
  assert.equal(timers.running, true)
  timers.advance(MOTION_TICK_MS)
  assert.deepEqual(loop.advanced, [MOTION_TICK_MS, MOTION_TICK_MS])
  clock.dispose()
})

test('a loop that starts later wakes a resting clock and is caught at once', async () => {
  const doc = fakeDocument([])
  const timers = fakeTimers()
  const clock = createMotionClock(doc, fakeActivity(ACTIVE), timers)
  await settle()
  assert.equal(timers.running, false)
  const loop = cssAnimation('status-dot-pulse')
  doc.startAnimation(loop)
  await settle()
  assert.equal(loop.playState, 'paused')
  assert.equal(timers.running, true)
  // The loop ends (its element unmounts): the clock rests again.
  doc.animations = []
  timers.advance(MOTION_TICK_MS)
  assert.equal(timers.running, false)
  clock.dispose()
})

test('a loop that starts while the window is in the background is still caught', async () => {
  const doc = fakeDocument([])
  const timers = fakeTimers()
  const clock = createMotionClock(doc, fakeActivity({ visible: true, focused: false }), timers)
  await settle()
  const loop = cssAnimation('ds-spinner-rotate')
  doc.startAnimation(loop)
  await settle()
  assert.equal(loop.playState, 'paused', 'caught where it stands, as a frame has no idle pause rule')
  assert.equal(timers.running, false, 'and not advanced: the clock only runs for an active window')
  clock.dispose()
})

test('a same-origin frame’s loops run on the same clock until it is released', async () => {
  const doc = fakeDocument([])
  const frame = fakeDocument([cssAnimation('ds-spinner-rotate')])
  const timers = fakeTimers()
  const clock = createMotionClock(doc, fakeActivity(ACTIVE), timers)
  await settle()
  const release = clock.addDocument(frame)
  await settle()
  const [loop] = frame.animations as FakeAnimation[]
  assert.equal(loop!.playState, 'paused')
  timers.advance(MOTION_TICK_MS)
  assert.deepEqual(loop!.advanced, [MOTION_TICK_MS])
  release()
  timers.advance(MOTION_TICK_MS)
  assert.deepEqual(loop!.advanced, [MOTION_TICK_MS])
  assert.equal(timers.running, false, 'with the frame gone nothing loops')
  clock.dispose()
})
