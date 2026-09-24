// The one background scheduler for what the studio pulls from the network on
// its own: app updates, the hosted card and sources feeds, and CLI version
// advisories.
// The cadence: feed and versions 15 s after the window is up and then hourly
// with a few minutes of jitter, updates hourly. A leg never overlaps itself,
// never runs offline, and never runs a subprocess probe — epic 1864's "no
// polling" ruling covers those, not these HTTP reads.
//
// The update check used to run every four minutes so that a session left open
// all day still learned about a same-day release. That was fifteen network
// wakes an hour on a machine that is mostly sitting in someone's bag, and the
// same freshness is available for far less: an hourly check, one on waking
// from sleep, and one the first time the person comes back to the app after
// half an hour away — which is exactly when a waiting update is worth knowing
// about. Nothing runs while the machine sleeps, and every interval stretches
// on battery.
//
// Timers and the clock are injected so the schedule is unit-tested without
// sleeping.
export const POLLER_FIRST_TICK_MS = 15_000
export const POLLER_UPDATE_INTERVAL_MS = 60 * 60_000
export const POLLER_FEED_INTERVAL_MS = 60 * 60_000
const POLLER_FEED_JITTER_MS = 5 * 60_000
/** How stale the last update check must be for a returning focus to run one. */
export const POLLER_FOCUS_UPDATE_AFTER_MS = 30 * 60_000
/** Every interval is this many times longer while the machine is on battery. */
export const POLLER_BATTERY_STRETCH = 4
/** A leg that came due while the machine slept runs this soon after it wakes. */
export const POLLER_WAKE_SETTLE_MS = 10_000

type PollerLeg = 'updates' | 'feed' | 'versions'

export type HostedFeedPollerDeps = {
  checkUpdates: () => Promise<unknown>
  refreshFeed: () => Promise<unknown>
  refreshVersions: () => Promise<unknown>
  isOnline?: () => boolean
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
  // 0..1, for the jitter. Injected so tests are deterministic.
  random?: () => number
  onError?: (leg: PollerLeg, error: unknown) => void
}

export type HostedFeedPoller = {
  start(): void
  stop(): void
  // Run one leg now (a manual check). Joins an in-flight run of the same leg.
  run(leg: PollerLeg): Promise<void>
  /** The machine is going to sleep: hold every timer until `wake`. */
  suspend(): void
  /**
   * The machine woke. Check for an update now — a release may have shipped
   * overnight — and pick the other legs back up where their intervals say.
   */
  wake(): void
  /** A window gained focus. Checks for an update if the last check is old enough. */
  noteFocus(): void
  /** Stretch (or restore) every interval, starting with what is left of the current waits. */
  setOnBattery(onBattery: boolean): void
  readonly running: boolean
}

const LEGS: readonly PollerLeg[] = ['updates', 'feed', 'versions']

export function createHostedFeedPoller(deps: HostedFeedPollerDeps): HostedFeedPoller {
  const setTimer = deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const isOnline = deps.isOnline ?? (() => true)
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const onError = deps.onError ?? ((leg, error) => console.warn(`[hosted-feed-poller] ${leg} failed`, error))

  const work: Record<PollerLeg, () => Promise<unknown>> = {
    updates: deps.checkUpdates,
    feed: deps.refreshFeed,
    versions: deps.refreshVersions,
  }
  const inFlight = new Map<PollerLeg, Promise<void>>()
  const timers = new Map<PollerLeg, unknown>()
  // When each leg is next due, on the wall clock. Kept apart from the timer so
  // a suspend, a wake or a change of power source can re-derive every timer
  // from the schedule instead of losing its place in it.
  const dueAt = new Map<PollerLeg, number>()
  let lastUpdateCheckAt = 0
  let running = false
  let suspended = false
  let onBattery = false

  const interval = (leg: PollerLeg): number => {
    const base =
      leg === 'updates'
        ? POLLER_UPDATE_INTERVAL_MS
        : POLLER_FEED_INTERVAL_MS + Math.round((random() * 2 - 1) * POLLER_FEED_JITTER_MS)
    return onBattery ? base * POLLER_BATTERY_STRETCH : base
  }

  const run = (leg: PollerLeg): Promise<void> => {
    const pending = inFlight.get(leg)
    if (pending) return pending
    if (leg === 'updates') lastUpdateCheckAt = now()
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

  const clearLegTimer = (leg: PollerLeg): void => {
    const existing = timers.get(leg)
    if (existing !== undefined) clearTimer(existing)
    timers.delete(leg)
  }

  // Offline: skip this tick, keep the rhythm. Nothing is retried early; the
  // next tick will find the network or not.
  const runThenReschedule = (leg: PollerLeg): void => {
    const tick = isOnline() ? run(leg) : Promise.resolve()
    void tick.finally(() => {
      if (running) schedule(leg, interval(leg))
    })
  }

  const arm = (leg: PollerLeg): void => {
    clearLegTimer(leg)
    if (!running || suspended) return
    const at = dueAt.get(leg)
    if (at === undefined) return
    timers.set(
      leg,
      setTimer(
        () => {
          timers.delete(leg)
          if (!running || suspended) return
          runThenReschedule(leg)
        },
        Math.max(0, at - now()),
      ),
    )
  }

  const schedule = (leg: PollerLeg, delay: number): void => {
    dueAt.set(leg, now() + delay)
    arm(leg)
  }

  // Run the update leg now and restart its interval from here.
  const checkUpdatesNow = (): void => {
    if (!running || suspended) return
    clearLegTimer('updates')
    dueAt.delete('updates')
    runThenReschedule('updates')
  }

  return {
    start() {
      if (running) return
      running = true
      suspended = false
      // The boot leg in runBootDiscovery already checked for an update; the
      // first scheduled check waits a full interval so it is not repeated.
      lastUpdateCheckAt = now()
      schedule('feed', POLLER_FIRST_TICK_MS)
      schedule('versions', POLLER_FIRST_TICK_MS)
      schedule('updates', interval('updates'))
    },
    stop() {
      running = false
      for (const leg of LEGS) clearLegTimer(leg)
      dueAt.clear()
    },
    run,
    suspend() {
      if (suspended) return
      suspended = true
      for (const leg of LEGS) clearLegTimer(leg)
    },
    wake() {
      suspended = false
      if (!running) return
      // A leg whose time passed during the nap runs shortly after the network
      // is back, not in the same instant every other waking service fires.
      const soonest = now() + POLLER_WAKE_SETTLE_MS
      for (const leg of LEGS) {
        if (leg === 'updates') continue
        const at = dueAt.get(leg)
        if (at !== undefined && at < soonest) dueAt.set(leg, soonest)
        arm(leg)
      }
      checkUpdatesNow()
    },
    noteFocus() {
      if (!running || suspended) return
      if (now() - lastUpdateCheckAt < POLLER_FOCUS_UPDATE_AFTER_MS) return
      checkUpdatesNow()
    },
    setOnBattery(next) {
      if (next === onBattery) return
      const factor = next ? POLLER_BATTERY_STRETCH : 1 / POLLER_BATTERY_STRETCH
      onBattery = next
      // Stretch (or shrink) what is left of each leg's current wait, so a
      // change of power source takes effect now rather than one interval late.
      const at = now()
      for (const leg of LEGS) {
        const due = dueAt.get(leg)
        if (due === undefined) continue
        dueAt.set(leg, at + Math.max(0, due - at) * factor)
        arm(leg)
      }
    },
    get running() {
      return running
    },
  }
}
