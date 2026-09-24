import { useEffect, useState } from 'react'

// One clock per interval, shared by every caller asking for that interval.
// Leaf timestamp components (a sidebar row's idle label, a tab's recency)
// each read their own `now`, so a list of a few hundred rows would otherwise
// start a few hundred timers that all fire on the same beat.
//
// The clock stops while the document is hidden: nothing is on screen to
// advance, and a minimized window has no reason to re-render every row
// twice a minute. It reads the time afresh the moment the window is shown.
type SharedClock = {
  now: number
  listeners: Set<(now: number) => void>
  timer: number | null
}

const clocks = new Map<number, SharedClock>()

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function tick(clock: SharedClock): void {
  clock.now = Date.now()
  for (const listener of clock.listeners) listener(clock.now)
}

function startClock(intervalMs: number, clock: SharedClock): void {
  if (clock.timer !== null || documentHidden()) return
  clock.timer = window.setInterval(() => tick(clock), intervalMs)
}

function stopClock(clock: SharedClock): void {
  if (clock.timer === null) return
  window.clearInterval(clock.timer)
  clock.timer = null
}

let visibilityListenerInstalled = false
function installVisibilityListener(): void {
  if (visibilityListenerInstalled || typeof document === 'undefined') return
  visibilityListenerInstalled = true
  document.addEventListener('visibilitychange', () => {
    for (const [intervalMs, clock] of clocks) {
      if (documentHidden()) {
        stopClock(clock)
      } else if (clock.listeners.size > 0) {
        tick(clock)
        startClock(intervalMs, clock)
      }
    }
  })
}

function subscribe(intervalMs: number, listener: (now: number) => void): () => void {
  installVisibilityListener()
  let clock = clocks.get(intervalMs)
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set(), timer: null }
    clocks.set(intervalMs, clock)
  }
  const shared = clock
  shared.listeners.add(listener)
  startClock(intervalMs, shared)
  return () => {
    shared.listeners.delete(listener)
    if (shared.listeners.size === 0) stopClock(shared)
  }
}

// `enabled` gates the ticking interval so callers behind a transient surface
// (e.g. a closed popover) don't pay an idle re-render. When it flips back to
// true the value refreshes immediately, so a long-paused source isn't stale on
// resume. Defaults to true, leaving always-on callers unchanged.
export function useRelativeNow(intervalMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return undefined
    setNow(Date.now())
    return subscribe(intervalMs, setNow)
  }, [intervalMs, enabled])
  return now
}
