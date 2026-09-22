// The one background scheduler for what the studio pulls from the network on
// its own: app updates, the hosted card and sources feeds, and CLI version
// advisories.
// The cadence: feed and versions 15 s after the window is up and then hourly
// with a few minutes of jitter, updates every four minutes. A leg never
// overlaps itself, never runs offline, and never runs a subprocess probe —
// epic 1864's "no polling" ruling covers those, not these HTTP reads.
//
// Timers and the clock are injected so the schedule is unit-tested without
// sleeping.
export const POLLER_FIRST_TICK_MS = 15_000
export const POLLER_UPDATE_INTERVAL_MS = 4 * 60_000
export const POLLER_FEED_INTERVAL_MS = 60 * 60_000
const POLLER_FEED_JITTER_MS = 5 * 60_000

type PollerLeg = 'updates' | 'feed' | 'versions'

export type HostedFeedPollerDeps = {
  checkUpdates: () => Promise<unknown>
  refreshFeed: () => Promise<unknown>
  refreshVersions: () => Promise<unknown>
  isOnline?: () => boolean
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  // 0..1, for the jitter. Injected so tests are deterministic.
  random?: () => number
  onError?: (leg: PollerLeg, error: unknown) => void
}

export type HostedFeedPoller = {
  start(): void
  stop(): void
  // Run one leg now (a manual check). Joins an in-flight run of the same leg.
  run(leg: PollerLeg): Promise<void>
  readonly running: boolean
}

export function createHostedFeedPoller(deps: HostedFeedPollerDeps): HostedFeedPoller {
  const setTimer = deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const isOnline = deps.isOnline ?? (() => true)
  const random = deps.random ?? Math.random
  const onError = deps.onError ?? ((leg, error) => console.warn(`[hosted-feed-poller] ${leg} failed`, error))

  const work: Record<PollerLeg, () => Promise<unknown>> = {
    updates: deps.checkUpdates,
    feed: deps.refreshFeed,
    versions: deps.refreshVersions,
  }
  const inFlight = new Map<PollerLeg, Promise<void>>()
  const timers = new Map<PollerLeg, unknown>()
  let running = false

  const interval = (leg: PollerLeg): number => {
    if (leg === 'updates') return POLLER_UPDATE_INTERVAL_MS
    return POLLER_FEED_INTERVAL_MS + Math.round((random() * 2 - 1) * POLLER_FEED_JITTER_MS)
  }

  const run = (leg: PollerLeg): Promise<void> => {
    const pending = inFlight.get(leg)
    if (pending) return pending
    const task = (async () => {
      try {
        await work[leg]()
      } catch (error) {
        onError(leg, error)
      }
    })().finally(() => {
      if (inFlight.get(leg) === task) inFlight.delete(leg)
    })
    inFlight.set(leg, task)
    return task
  }

  const schedule = (leg: PollerLeg, delay: number): void => {
    const existing = timers.get(leg)
    if (existing !== undefined) clearTimer(existing)
    timers.set(
      leg,
      setTimer(() => {
        timers.delete(leg)
        if (!running) return
        // Offline: skip this tick, keep the rhythm. Nothing is retried early;
        // the next tick will find the network or not.
        const tick = isOnline() ? run(leg) : Promise.resolve()
        void tick.finally(() => {
          if (running) schedule(leg, interval(leg))
        })
      }, delay),
    )
  }

  return {
    start() {
      if (running) return
      running = true
      schedule('feed', POLLER_FIRST_TICK_MS)
      schedule('versions', POLLER_FIRST_TICK_MS)
      // The boot leg in runBootDiscovery already checked for an update; the
      // first scheduled check waits a full interval so it is not repeated.
      schedule('updates', POLLER_UPDATE_INTERVAL_MS)
    },
    stop() {
      running = false
      for (const handle of timers.values()) clearTimer(handle)
      timers.clear()
    },
    run,
    get running() {
      return running
    },
  }
}
