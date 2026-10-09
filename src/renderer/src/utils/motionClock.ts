import { windowActivity, type WindowActivity, type WindowActivityState } from './windowActivity'

// The motion clock: every looping CSS animation in the window — the working
// marks, the agent characters, the spinners, the pulses, the shimmer — is held
// paused and stepped forward from one shared timer a few times a second,
// rather than left running.
//
// Why. A running CSS animation asks for a new frame at the display's refresh
// rate for as long as it runs, however small it is: the renderer produces
// 60–120 frames a second and the window server composites the whole window
// for each one. A 3px working mark beside a running agent kept the window
// server busy for the whole time the agent worked. `steps()` timing barely
// helps, because the animation is still running and still asks for every
// frame. Held paused and advanced through `currentTime`, the same animation
// asks for one frame per tick: on a test page of working marks and agent
// characters it took the renderer and GPU from about 14% of a core to about
// 6%, and the window server composites eight frames a second instead of
// sixty or more.
//
// Only infinite CSS animations are taken over. An entrance, a toast or a
// popover still plays out at full rate. A loop the stylesheet is holding still
// (the idle pause rule in index.css: off screen, a hidden layer, an inert
// region) is left where it stands, and resumes on the clock once the
// stylesheet lets it go. While the window is hidden or in the background the
// clock stops, and every loop it holds stays on the frame it reached.

/** How often the held loops advance. Eight frames a second keeps them moving. */
export const MOTION_TICK_MS = 125

type MotionView = { getComputedStyle(element: Element, pseudoElement?: string | null): CSSStyleDeclaration }

export type MotionDocument = {
  getAnimations(): Animation[]
  addEventListener(type: 'animationstart', listener: () => void): void
  removeEventListener(type: 'animationstart', listener: () => void): void
  defaultView: MotionView | null
}

type MotionTimers = {
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(id: unknown): void
  now(): number
  /** Runs `task` once the current burst of events is over (a microtask). */
  defer(task: () => void): void
}

/**
 * Calls `wake` when the stylesheet may have let a held loop go: the pause rule
 * in index.css keys on these attributes, and nothing else announces the
 * change. Returns the unbind.
 */
export type StylesheetReleaseWatch = (wake: () => void) => () => void

export type MotionClock = {
  /** Hold a same-origin frame's loops on this clock too. Returns the release. */
  addDocument(doc: MotionDocument): () => void
  dispose(): void
}

function isLoop(animation: Animation): boolean {
  // `animationName` is what a CSS animation has and a transition or a script's
  // `element.animate()` does not.
  if (!('animationName' in animation)) return false
  return animation.effect?.getComputedTiming().iterations === Infinity
}

// Whether the stylesheet holds this loop paused. `animation-play-state` is a
// list matched to `animation-name` by position, so an element running two
// animations (an entrance and a loop) is read for the loop's own entry.
function heldByStylesheet(animation: Animation, view: MotionView | null): boolean {
  const effect = animation.effect as KeyframeEffect | null
  const target = effect?.target
  if (!target || !view) return false
  const style = view.getComputedStyle(target, effect.pseudoElement)
  const names = style.animationName.split(',').map((name) => name.trim())
  const states = style.animationPlayState.split(',').map((state) => state.trim())
  const index = Math.max(0, names.indexOf((animation as CSSAnimation).animationName))
  return states[index % states.length] === 'paused'
}

export function createMotionClock(
  doc: MotionDocument,
  activity: WindowActivity,
  timers: MotionTimers = {
    setInterval: (handler, ms) => window.setInterval(handler, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    now: () => performance.now(),
    defer: (task) => queueMicrotask(task),
  },
  watchStylesheetRelease?: StylesheetReleaseWatch,
): MotionClock {
  const documents = new Set<MotionDocument>()
  // The loops this clock has paused. One it has not yet seen is caught where it
  // stands, not advanced: it has been running on its own until now.
  const held = new WeakSet<Animation>()
  let timer: unknown = null
  let lastTick = 0
  let wakeQueued = false
  const isActive = (state: WindowActivityState = activity.get()): boolean => state.visible && state.focused

  // Reads every loop's play state before writing to any of them: a write marks
  // its element's style dirty, and a read after it would recompute style once
  // per loop instead of once per sweep. Says whether any loop is free to move.
  const sweep = (elapsed: number): boolean => {
    const free: Animation[] = []
    for (const source of documents) {
      for (const animation of source.getAnimations()) {
        if (isLoop(animation) && !heldByStylesheet(animation, source.defaultView)) free.push(animation)
      }
    }
    for (const animation of free) {
      if (!held.has(animation)) {
        held.add(animation)
        animation.pause()
      } else if (elapsed > 0) {
        animation.currentTime = (Number(animation.currentTime) || 0) + elapsed
      }
    }
    return free.length > 0
  }

  const stop = (): void => {
    if (timer === null) return
    timers.clearInterval(timer)
    timer = null
  }

  // With nothing free to move — no loop at all, or every one held still by the
  // stylesheet — the timer rests until a loop starts, the stylesheet lets one
  // go, or the window comes back.
  const tick = (): void => {
    const now = timers.now()
    const elapsed = now - lastTick
    lastTick = now
    if (!sweep(elapsed)) stop()
  }

  const start = (): void => {
    if (timer !== null || !isActive()) return
    lastTick = timers.now()
    if (!sweep(0)) return
    timer = timers.setInterval(tick, MOTION_TICK_MS)
  }

  // A loop that just started, a frame just added, or a loop the stylesheet just
  // let go wakes the clock if the window is active, and is caught at once
  // rather than left running until the next tick. With the window idle,
  // whatever loops is caught where it stands: in this document the stylesheet
  // already holds every loop still then, but its rule cannot reach into a
  // frame. A burst (a list mounting a row of marks) is one sweep, not one per
  // event.
  const wake = (): void => {
    if (wakeQueued) return
    wakeQueued = true
    timers.defer(() => {
      wakeQueued = false
      if (timer === null && isActive()) start()
      else sweep(0)
    })
  }

  const unsubscribe = activity.subscribe((state) => {
    if (isActive(state)) return start()
    stop()
    sweep(0)
  })
  const unwatch = watchStylesheetRelease?.(wake) ?? (() => undefined)

  const addDocument = (source: MotionDocument): (() => void) => {
    if (documents.has(source)) return () => undefined
    documents.add(source)
    source.addEventListener('animationstart', wake)
    wake()
    return () => {
      source.removeEventListener('animationstart', wake)
      documents.delete(source)
    }
  }

  addDocument(doc)

  return {
    addDocument,
    dispose() {
      stop()
      unsubscribe()
      unwatch()
      for (const source of [...documents]) {
        source.removeEventListener('animationstart', wake)
        documents.delete(source)
      }
    },
  }
}

// The attributes the idle pause rule in index.css keys on, besides the
// window's own `data-window-active` (which the clock hears from the window's
// activity). assets/idleAnimations.test.ts checks this list against the rule.
export const STYLESHEET_PAUSE_ATTRIBUTES = ['data-live-offscreen', 'data-layer-state', 'data-pane-collapsed', 'inert']

function watchDocumentAttributes(root: Element): StylesheetReleaseWatch {
  return (wake) => {
    if (typeof MutationObserver !== 'function') return () => undefined
    const observer = new MutationObserver(wake)
    observer.observe(root, { attributes: true, subtree: true, attributeFilter: STYLESHEET_PAUSE_ATTRIBUTES })
    return () => observer.disconnect()
  }
}

const NO_CLOCK: MotionClock = {
  addDocument: () => () => undefined,
  dispose: () => undefined,
}

let shared: MotionClock | null = null

/**
 * This window's motion clock. Where the Web Animations API is missing (jsdom,
 * tests) the loops are left to the stylesheet, as they were before the clock.
 */
export function motionClock(): MotionClock {
  if (shared) return shared
  if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return NO_CLOCK
  shared = createMotionClock(document, windowActivity(), undefined, watchDocumentAttributes(document.documentElement))
  return shared
}
