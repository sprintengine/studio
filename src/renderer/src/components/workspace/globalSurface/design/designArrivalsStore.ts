import { useSyncExternalStore } from 'react'

import type { DesignSystemBundleArrivals } from '../../../../../../shared/design-system/arrivals'

// The arrival dates the Design ROW counts, held outside the Design door.
//
// The door computes its markers from the bundles it has read, and those reads
// die with it. The Extensions drawer's Design row has to carry a count while the
// door is closed — which is most of the time — so the dates live here, in module
// state that outlives every mount, exactly as a door's own index does for the
// sidebar entry and its surface.
//
// Two sources feed it, and they must agree:
//
//   - `window.api.listDesignSystemArrivals()`, the cheap library-wide read. Once
//     on first subscribe, hourly while anyone is watching, and on demand when
//     the library itself changes.
//   - `reportDesignArrivals`, called by the door with what it just read. The
//     door's read is fresher than the last listing, and while it is open the row
//     and the door must not be able to disagree about the same bundle.
//
// A refresh is hourly, not on a watcher: nothing here is live data. Arrival
// dates change when the user commits in their editor, and the door already has
// an explicit Reload for the moment that matters.

export type DesignArrivalsLoadState = 'loading' | 'ready' | 'error'

export type DesignArrivalsSnapshot = {
  bundles: readonly DesignSystemBundleArrivals[]
  loadState: DesignArrivalsLoadState
}

/** Slow on purpose: see above — this is a date on disk, not a running process. */
const REFRESH_MS = 60 * 60 * 1000

const EMPTY: readonly DesignSystemBundleArrivals[] = []

let snapshot: DesignArrivalsSnapshot = { bundles: EMPTY, loadState: 'loading' }

const listeners = new Set<() => void>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInFlight = false
let loadedOnce = false

function publish(next: DesignArrivalsSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/**
 * The current snapshot. Stable by identity between publishes, as
 * `useSyncExternalStore` requires — a fresh object per call would re-render
 * every consumer on every render pass.
 */
export function getDesignArrivalsSnapshot(): DesignArrivalsSnapshot {
  return snapshot
}

/**
 * Subscribe a consumer. The first one starts the read and the hourly refresh;
 * the last one to leave stops the timer, so a window with the drawer closed
 * holds no interval at all.
 */
export function subscribeDesignArrivals(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    // Once, not per subscriber: a second consumer mounting onto a warm store
    // reads the rows the first one already paid for.
    if (!loadedOnce) void load()
    if (!refreshTimer) refreshTimer = setInterval(() => void load(), REFRESH_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }
}

/**
 * Read the library's arrival dates now.
 *
 * The library changed — a folder registered, forgotten or seeded — so the count
 * describes a library nobody has any more until this lands.
 */
export function reloadDesignArrivals(): void {
  void load()
}

/**
 * Merge one bundle's dates, from a read the door just did.
 *
 * The door's map is authoritative for that bundle: it was read a moment ago,
 * whereas the listing may be an hour old. Merged rather than replaced, so a read
 * that resolved fewer entries (a manifest mid-edit) cannot silently delete dates
 * the row already had.
 *
 * A report that changes nothing publishes nothing — the door calls this from an
 * effect that runs on every read, and an identical publish would re-render every
 * consumer for no news.
 */
export function reportDesignArrivals(
  bundleId: string,
  path: string,
  addedAt: Readonly<Record<string, string>> | null | undefined,
): void {
  if (!bundleId || !addedAt) return
  const existing = snapshot.bundles.find((bundle) => bundle.bundleId === bundleId)
  const merged = { ...existing?.addedAt, ...addedAt }
  if (existing && existing.path === path && sameDates(existing.addedAt, merged)) return
  const row: DesignSystemBundleArrivals = { bundleId, path, addedAt: merged }
  const bundles = existing
    ? snapshot.bundles.map((bundle) => (bundle.bundleId === bundleId ? row : bundle))
    : [...snapshot.bundles, row]
  // A door that has read a bundle is data the row can count, whatever the
  // listing is doing: never leave a reported bundle behind a 'loading' row.
  publish({ bundles, loadState: snapshot.loadState === 'error' ? 'error' : 'ready' })
}

function sameDates(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  return keys.every((key) => a[key] === b[key])
}

async function load(): Promise<void> {
  // One read at a time: two overlapping listings can resolve out of order and
  // publish the older library.
  if (loadInFlight) return
  // Absent in a detached window and in tests, where `window.api` is whatever the
  // test installed. An empty, READY store is the honest answer there — a count
  // of nothing, not a row stuck reporting that it is still loading.
  if (typeof window === 'undefined' || typeof window.api?.listDesignSystemArrivals !== 'function') {
    loadedOnce = true
    publish({ bundles: snapshot.bundles, loadState: 'ready' })
    return
  }
  loadInFlight = true
  try {
    const result = await window.api.listDesignSystemArrivals()
    loadedOnce = true
    publish({ bundles: result.bundles, loadState: 'ready' })
  } catch {
    loadedOnce = true
    // The rows already known stay: an unreadable library is a stale count, which
    // is better than a badge that vanishes and reappears on a timer.
    publish({ bundles: snapshot.bundles, loadState: 'error' })
  } finally {
    loadInFlight = false
  }
}

/**
 * The dates every consumer reads. The snapshot is shared, so the drawer row and
 * anything else that counts arrivals see the same library.
 */
export function useDesignArrivals(enabled = true): DesignArrivalsSnapshot {
  // Off, the hook subscribes to nothing: the rail hook lives in every window
  // for the app's life, and with the design module disabled there is no row
  // to count for — so no listing, no `git log` per bundle, no hourly timer
  // (review, 2026-09-09).
  return useSyncExternalStore(
    enabled ? subscribeDesignArrivals : subscribeNothing,
    enabled ? getDesignArrivalsSnapshot : getEmptySnapshot,
    enabled ? getDesignArrivalsSnapshot : getEmptySnapshot,
  )
}

const EMPTY_SNAPSHOT: DesignArrivalsSnapshot = { bundles: EMPTY, loadState: 'ready' }
const getEmptySnapshot = (): DesignArrivalsSnapshot => EMPTY_SNAPSHOT
const subscribeNothing = (): (() => void) => () => {}

/**
 * Drop all store state. Tests only: the module state deliberately outlives
 * mounts, so a test process that exercises more than one case needs a way back
 * to a cold store.
 */
export function resetDesignArrivalsForTests(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  listeners.clear()
  snapshot = { bundles: EMPTY, loadState: 'loading' }
  loadInFlight = false
  loadedOnce = false
}
