// Layout changes a terminal should not follow frame by frame.
//
// A terminal answers every size change with `fitAddon.fit()` and a pty resize,
// and a pty resize makes the agent CLI in it redraw its whole screen. Doing
// that on each frame of a width glide or a column drag is what made the view
// jump: the TUI repaints at every intermediate width while the pane is still
// moving. So two kinds of layout change hold a terminal's fit back.
//
// 1. A CSS transition on a layout property (the sidebar's width glide, the
//    paused-agent footer's row ease, anything added later). It is read off the
//    transition events themselves: `transitionrun` marks it in flight, and
//    `transitionend` or `transitioncancel` lands it. A fit parked behind one
//    runs once, at the final size. This replaces a timer that had to be kept
//    in step with a `duration-150` class by hand, and which held every fit for
//    210 ms after a sidebar toggle that does not animate at all.
// 2. An interactive column drag (`columnResizeDrag.ts`). The terminal still
//    tracks the pointer, throttled the way a window resize is, and fits once
//    more when the drag ends.
//
// While a fit is parked the terminal keeps drawing at its last size, anchored
// top-left in its container, so the text holds still instead of reflowing.
//
// Nothing here renders: it is a module-level set with imperative subscribers,
// read inside the terminals' ResizeObserver callbacks.

// The properties whose transition moves a box's size or the size of its
// siblings. `left`/`top` and the like are left out: they move an absolutely
// positioned element without resizing anything around it (a switch thumb).
const LAYOUT_PROPERTIES = new Set([
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'flex-basis',
  'flex-grow',
  'flex-shrink',
  'grid-template-columns',
  'grid-template-rows',
  'padding-left',
  'padding-right',
  'padding-top',
  'padding-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'margin-bottom',
])

// A transition whose end event never arrives (its element was detached
// between frames) must not hold fits forever.
export const LAYOUT_TRANSITION_MAX_HOLD_MS = 1000

type Listener = () => void

// Element → property → when it started.
const running = new Map<Element, Map<string, number>>()
const settleListeners = new Set<Listener>()
let installed = false
let interactiveResizes = 0
let staleTimer: number | null = null

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function notifySettled(): void {
  for (const listener of [...settleListeners]) listener()
}

function pruneStale(): boolean {
  const cutoff = now() - LAYOUT_TRANSITION_MAX_HOLD_MS
  let pruned = false
  for (const [element, properties] of running) {
    for (const [property, startedAt] of properties) {
      if (startedAt > cutoff) continue
      properties.delete(property)
      pruned = true
    }
    if (properties.size === 0) running.delete(element)
  }
  return pruned
}

function armStaleTimer(): void {
  if (staleTimer !== null || typeof window === 'undefined') return
  staleTimer = window.setTimeout(() => {
    staleTimer = null
    if (pruneStale()) notifySettled()
    if (running.size > 0) armStaleTimer()
  }, LAYOUT_TRANSITION_MAX_HOLD_MS)
}

function isLayoutTransitionEvent(event: Event): event is TransitionEvent & { target: Element } {
  const { propertyName, target } = event as TransitionEvent
  return (
    typeof propertyName === 'string' &&
    LAYOUT_PROPERTIES.has(propertyName) &&
    target !== null &&
    typeof (target as Element).contains === 'function'
  )
}

/** Start listening. Idempotent; a no-op outside a document. */
export function installLayoutTransitionTracking(): void {
  if (installed || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
  installed = true
  document.addEventListener(
    'transitionrun',
    (event) => {
      if (!isLayoutTransitionEvent(event)) return
      const properties = running.get(event.target) ?? new Map<string, number>()
      properties.set(event.propertyName, now())
      running.set(event.target, properties)
      armStaleTimer()
    },
    true,
  )
  const land = (event: Event): void => {
    if (!isLayoutTransitionEvent(event)) return
    const properties = running.get(event.target)
    if (!properties?.delete(event.propertyName)) return
    if (properties.size === 0) running.delete(event.target)
    notifySettled()
  }
  document.addEventListener('transitionend', land, true)
  document.addEventListener('transitioncancel', land, true)
}

/**
 * True while a layout transition is in flight that can change `container`'s
 * size: one on the container or an ancestor of it, or on a sibling of one of
 * those (the sidebar beside the content column the terminal sits in).
 */
export function isLayoutTransitionAffecting(container: Element): boolean {
  if (running.size === 0) return false
  pruneStale()
  for (const element of running.keys()) {
    if (element.contains(container)) return true
    const parent = element.parentElement
    if (parent && parent.contains(container)) return true
  }
  return false
}

/** True while a column is being dragged to a new width. */
export function isInteractiveLayoutResize(): boolean {
  return interactiveResizes > 0
}

/**
 * Marks an interactive column drag. Returns the call that ends it; the end
 * lets parked fits run once at the final size.
 */
export function beginInteractiveLayoutResize(): () => void {
  interactiveResizes += 1
  let ended = false
  return () => {
    if (ended) return
    ended = true
    interactiveResizes = Math.max(0, interactiveResizes - 1)
    if (interactiveResizes === 0) notifySettled()
  }
}

/** Called whenever a transition lands or a drag ends; the caller re-checks its own gate. */
export function onLayoutSettled(listener: Listener): () => void {
  settleListeners.add(listener)
  return () => {
    settleListeners.delete(listener)
  }
}

/** Test-only: forget every tracked transition and drag. */
export function __resetLayoutTransitionsForTests(): void {
  running.clear()
  interactiveResizes = 0
  if (staleTimer !== null && typeof window !== 'undefined') window.clearTimeout(staleTimer)
  staleTimer = null
}
