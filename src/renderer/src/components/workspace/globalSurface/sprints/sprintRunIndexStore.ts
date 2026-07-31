import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { dropDeletedSprintRunDebris } from './sprintRunTombstones'

// The Sprints run index as ONE shared store, not one copy per mounted consumer.
//
// Two components read this index: `SprintsNavEntry` (the sidebar door, mounted
// for the whole session so its aggregate dot stays live) and
// `SprintsGlobalSurface` (the door itself, while open). Each used to call the
// hook independently, so each opened its own `onSprintRunsChanged` subscription
// and ran its own full `listSprintRuns` disk scan — every projection write cost
// two enumerations of every run under every project root, and handed React two
// fresh 40-element arrays to reconcile.
//
// The scan is cheap at rest (~43 ms cold across 40 runs, and the main-process
// summaries are memoized on the projection's mtime+size), which is why this was
// never visible day to day. It is the BURST that matters: sprint startup rewrites
// projections rapidly — task graph created, agents joining, task statuses landing
// — and that is exactly when the machine is already busy spawning agent processes.
// Paying twice for every event in that window is the cost this removes.
//
// Everything below is module state on purpose: the store outlives any single
// mount, so opening the door reuses the rows the sidebar already has instead of
// starting from an empty rail.

export type SprintRunIndexLoadState = 'loading' | 'ready' | 'error'

export type SprintRunIndexSnapshot = {
  runs: SprintRunSummary[]
  loadState: SprintRunIndexLoadState
  /** Raw failure text, shown only behind the error card's "Show details". */
  error: string | null
}

// At most one scan per window, and the FIRST call in a quiet period runs
// immediately (leading edge). Two properties matter here:
//
//   - Leading edge, so opening the door starts its read at once. A window-first
//     scheduler would delay the initial load by the full window and the rail
//     would sit empty for no reason — a burst is the thing worth coalescing, not
//     the first read.
//   - A fixed window rather than a trailing debounce, the shape main's
//     `scheduleProjectionNotify` uses and for the same reason: a trailing
//     debounce is restarted by every write, so an engine writing faster than the
//     window would starve the refetch and the rail would sit stale while a run is
//     very much moving.
//
// Under sustained writes this settles at one scan per window, however many runs
// are writing and however many components are reading.
const REFETCH_COALESCE_MS = 250

const EMPTY_RUNS: readonly SprintRunSummary[] = []

let snapshot: SprintRunIndexSnapshot = {
  runs: EMPTY_RUNS as SprintRunSummary[],
  loadState: 'loading',
  error: null,
}

const listeners = new Set<() => void>()

// The project roots to scan, as the encoded key the hook compares on plus the
// decoded list handed to the IPC call. Held here so every consumer scans the
// same roots and a root-set change reloads exactly once.
let rootsKey = ''
let roots: string[] = []

let unsubscribeFromMain: (() => void) | null = null
// Open while a coalescing window is running. Its presence — not a timestamp — is
// what makes a call during the window fold into `pendingInWindow`.
let windowTimer: ReturnType<typeof setTimeout> | null = null
let pendingInWindow = false
let loadInFlight = false
// Set when an event arrives mid-load (or a load finished against a stale root
// set): the `finally` re-schedules rather than dropping the change on the floor.
let reloadRequested = false

function publish(next: SprintRunIndexSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** The current snapshot. Stable by identity between publishes, as
 * `useSyncExternalStore` requires — never build a fresh object here. */
export function getSprintRunIndexSnapshot(): SprintRunIndexSnapshot {
  return snapshot
}

/**
 * Subscribe a consumer. The FIRST subscriber opens the single main-process
 * subscription; the last one to leave closes it and drops any pending refetch,
 * so a session with the door closed and the sidebar hidden holds no listener at
 * all.
 */
export function subscribeSprintRunIndex(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) openMainSubscription()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) closeMainSubscription()
  }
}

function openMainSubscription(): void {
  if (unsubscribeFromMain) return
  // Refetch when any run's projection changes — coalesced, so a burst across
  // several live runs costs one scan instead of one per write per consumer.
  unsubscribeFromMain = window.api.onSprintRunsChanged(() => scheduleCoalescedRefresh())
}

function closeMainSubscription(): void {
  unsubscribeFromMain?.()
  unsubscribeFromMain = null
  if (windowTimer) {
    clearTimeout(windowTimer)
    windowTimer = null
  }
  pendingInWindow = false
  reloadRequested = false
}

/**
 * Point the index at a set of project roots. A no-op when the set is unchanged,
 * so every consumer can call it on every render pass; a real change schedules
 * one reload.
 */
export function setSprintRunIndexRoots(nextRootsKey: string): void {
  if (nextRootsKey === rootsKey) return
  rootsKey = nextRootsKey
  roots = decodeRoots(nextRootsKey)
  // A different set of projects is a different index — read it now rather than
  // leaving the rail describing roots the window no longer has open.
  refreshSprintRunIndex()
}

function decodeRoots(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(key)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * A projection changed. Runs immediately when no window is open, otherwise folds
 * into the one already running — this is the path a burst travels, and the only
 * one that coalesces.
 */
function scheduleCoalescedRefresh(): void {
  if (windowTimer) {
    pendingInWindow = true
    return
  }
  openWindow()
  void load()
}

/**
 * Read the index now, for a reason the user caused: a consumer mounting (the
 * door opening, the sidebar entry appearing), the project roots changing, or the
 * error card's "Try again". None of those are bursts, so none of them wait out a
 * coalescing window — a deferred read here would leave the rail empty while the
 * data was already on disk.
 *
 * Collapses against an in-flight scan rather than queueing behind it: that scan
 * is already reading the same roots and will publish rows this caller can use, so
 * mounting both consumers at once costs ONE scan, not two.
 */
export function refreshSprintRunIndex(): void {
  if (loadInFlight) return
  void load()
}

function openWindow(): void {
  windowTimer = setTimeout(() => {
    windowTimer = null
    if (!pendingInWindow) return
    pendingInWindow = false
    scheduleCoalescedRefresh()
  }, REFETCH_COALESCE_MS)
}

async function load(): Promise<void> {
  // One scan at a time. A second caller marks the index dirty instead of racing:
  // two overlapping scans can resolve out of order and publish stale rows.
  if (loadInFlight) {
    reloadRequested = true
    return
  }
  loadInFlight = true
  const requestedRootsKey = rootsKey
  try {
    const listed = await window.api.listSprintRuns(roots)
    // The root set moved while this scan was in flight: its rows describe a set
    // of projects nobody asked for any more. Drop them and re-run.
    if (requestedRootsKey !== rootsKey) {
      reloadRequested = true
      return
    }
    // A run the operator deleted can be recreated on disk by a writer that
    // outlived it; that folder is debris, not a run (item 1812).
    publish({ runs: dropDeletedSprintRunDebris(listed), loadState: 'ready', error: null })
  } catch (cause) {
    if (requestedRootsKey !== rootsKey) {
      reloadRequested = true
      return
    }
    // An unreadable index is an error state with a retry, never an empty rail
    // pretending there are no sprints — so the rows already on screen stay.
    publish({
      runs: snapshot.runs,
      loadState: 'error',
      error: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    loadInFlight = false
    if (reloadRequested) {
      reloadRequested = false
      scheduleCoalescedRefresh()
    }
  }
}

/**
 * Drop all store state. Tests only: the module state deliberately outlives
 * mounts, so a test process that renders more than once needs a way back to a
 * cold index.
 */
export function resetSprintRunIndexForTests(): void {
  closeMainSubscription()
  listeners.clear()
  snapshot = { runs: EMPTY_RUNS as SprintRunSummary[], loadState: 'loading', error: null }
  rootsKey = ''
  roots = []
  loadInFlight = false
}
