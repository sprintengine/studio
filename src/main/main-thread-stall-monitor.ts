/**
 * Notices when the main process's event loop stops answering, and says so in
 * the diagnostics log.
 *
 * Every keystroke a terminal sends, every click that focuses one and every
 * paste crosses the main process on its way to the pty, so a main thread that
 * is busy for two seconds is two seconds of a dead terminal and, on Windows, a
 * busy cursor over the whole window. Nothing else in the app can see that from
 * the inside: the renderer only sees an IPC reply arrive late, and the slow-IPC
 * log only covers handlers that were themselves slow, not the ones that queued
 * behind something else.
 *
 * The measurement is a heartbeat: a timer that should fire every `intervalMs`,
 * and the difference between when it should have fired and when it did. That
 * difference is time the loop spent on something else. It costs one timer tick
 * twice a second and allocates nothing while the loop is healthy.
 *
 * It writes to the same JSONL log the Diagnostics "Open logs folder" action
 * opens, because that is the one place a person on a packaged build can reach
 * without a console — which is exactly the machine where this matters. Reports
 * are rolled up so a loop that is stalling constantly writes one line a minute,
 * not one per stall.
 */

export type MainThreadStallReport = {
  /** Stalls at or over the threshold since the last report. */
  stalls: number
  /** The longest of them, in ms. */
  maxStallMs: number
  /** Their sum, in ms: how much of the window the loop was not answering. */
  totalStallMs: number
  /** How long the roll-up covers, in ms. */
  windowMs: number
}

export type MainThreadStallMonitorDeps = {
  report: (report: MainThreadStallReport) => void
  now?: () => number
  timers?: {
    setInterval(handler: () => void, ms: number): unknown
    clearInterval(handle: unknown): void
  }
  intervalMs?: number
  thresholdMs?: number
  reportEveryMs?: number
}

/** Heartbeat period. Short enough to see a one-second stall, long enough to cost nothing. */
const HEARTBEAT_INTERVAL_MS = 500
/**
 * A stall worth writing down. Under this is a GC pause or a large JSON parse —
 * noticeable, not the multi-second freeze a person reports. Over it, the
 * keyboard visibly stops.
 */
const STALL_THRESHOLD_MS = 1_000
/** The most often a report is written while stalls keep coming. */
const REPORT_EVERY_MS = 60_000

export function createMainThreadStallMonitor(deps: MainThreadStallMonitorDeps) {
  const now = deps.now ?? (() => performance.now())
  const timers = deps.timers ?? {
    setInterval: (handler: () => void, ms: number) => {
      const handle = setInterval(handler, ms)
      // Never the reason the process stays alive.
      handle.unref?.()
      return handle
    },
    clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
  }
  const intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const thresholdMs = deps.thresholdMs ?? STALL_THRESHOLD_MS
  const reportEveryMs = deps.reportEveryMs ?? REPORT_EVERY_MS

  let handle: unknown = null
  let lastTickAt = 0
  let windowStartedAt = 0
  let lastReportAt = Number.NEGATIVE_INFINITY
  let stalls = 0
  let maxStallMs = 0
  let totalStallMs = 0

  const flush = (at: number): void => {
    if (stalls === 0) return
    const report: MainThreadStallReport = {
      stalls,
      maxStallMs: Math.round(maxStallMs),
      totalStallMs: Math.round(totalStallMs),
      windowMs: Math.round(at - windowStartedAt),
    }
    stalls = 0
    maxStallMs = 0
    totalStallMs = 0
    windowStartedAt = at
    lastReportAt = at
    try {
      deps.report(report)
    } catch {
      // Diagnostics only; a failing reporter must not take the heartbeat down.
    }
  }

  const tick = (): void => {
    const at = now()
    const lateMs = at - lastTickAt - intervalMs
    lastTickAt = at
    if (lateMs >= thresholdMs) {
      if (stalls === 0 && at - lastReportAt >= reportEveryMs) windowStartedAt = at - lateMs
      stalls += 1
      maxStallMs = Math.max(maxStallMs, lateMs)
      totalStallMs += lateMs
    }
    // The first stall after a quiet spell is written at once — that is the one
    // somebody is about to describe — and the ones after it are rolled up.
    if (stalls > 0 && at - lastReportAt >= reportEveryMs) flush(at)
  }

  return {
    start(): void {
      if (handle !== null) return
      lastTickAt = now()
      windowStartedAt = lastTickAt
      handle = timers.setInterval(tick, intervalMs)
    },
    stop(): void {
      if (handle === null) return
      timers.clearInterval(handle)
      handle = null
      flush(now())
    },
  }
}
