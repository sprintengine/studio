import { useEffect, useState } from 'react'

import { onWindowVisibilityChange, windowActivity, type WindowActivity } from '../utils/windowActivity'

// One clock per interval, shared by every caller asking for that interval.
// Leaf timestamp components (a sidebar row's idle label, a tab's recency)
// each read their own `now`, so a list of a few hundred rows would otherwise
// start a few hundred timers that all fire on the same beat.
//
// The clock stops while the window cannot be seen: nothing is on screen to
// advance, and a minimized window has no reason to re-render every row
// twice a minute. It reads the time afresh the moment the window is shown.
// "Cannot be seen" is the window-activity signal, not `document.hidden`: on
// macOS a minimized or covered window keeps reporting itself visible, and only
// main knows otherwise.
type SharedClock = {
  now: number
  listeners: Set<(now: number) => void>
  timer: ReturnType<typeof setInterval> | null
}

export type RelativeNowClocks = {
  subscribe(intervalMs: number, listener: (now: number) => void): () => void
}

export function createRelativeNowClocks(activity: WindowActivity, clock: { now(): number } = Date): RelativeNowClocks {
  const clocks = new Map<number, SharedClock>()
  let visibilityBound = false

  const tick = (shared: SharedClock): void => {
    shared.now = clock.now()
    for (const listener of shared.listeners) listener(shared.now)
  }
  const start = (intervalMs: number, shared: SharedClock): void => {
    if (shared.timer !== null || !activity.get().visible) return
    shared.timer = setInterval(() => tick(shared), intervalMs)
  }
  const stop = (shared: SharedClock): void => {
    if (shared.timer === null) return
    clearInterval(shared.timer)
    shared.timer = null
  }
  // Bound once, on the first subscriber, and kept: the clocks live as long as
  // the window does.
  const bindVisibility = (): void => {
    if (visibilityBound) return
    visibilityBound = true
    onWindowVisibilityChange((visible) => {
      for (const [intervalMs, shared] of clocks) {
        if (!visible) {
          stop(shared)
        } else if (shared.listeners.size > 0) {
          tick(shared)
          start(intervalMs, shared)
        }
      }
    }, activity)
  }

  return {
    subscribe(intervalMs, listener) {
      bindVisibility()
      let shared = clocks.get(intervalMs)
      if (!shared) {
        shared = { now: clock.now(), listeners: new Set(), timer: null }
        clocks.set(intervalMs, shared)
      }
      const current = shared
      current.listeners.add(listener)
      start(intervalMs, current)
      return () => {
        current.listeners.delete(listener)
        if (current.listeners.size === 0) stop(current)
      }
    },
  }
}

let sharedClocks: RelativeNowClocks | null = null
function relativeNowClocks(): RelativeNowClocks {
  sharedClocks ??= createRelativeNowClocks(windowActivity())
  return sharedClocks
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
    return relativeNowClocks().subscribe(intervalMs, setNow)
  }, [intervalMs, enabled])
  return now
}
