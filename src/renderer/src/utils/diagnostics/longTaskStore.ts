// Long-task tracking: any main-thread task the browser reports as >50ms via the
// `longtask` PerformanceObserver entry type. These are the stalls operators feel
// as jank (the 700ms replay write we chased lives here). The store is a bounded
// ring; the summarizer is pure so it unit-tests without a browser.
const LONG_TASK_HISTORY_LIMIT = 300

// PerformanceObserver only surfaces tasks at/over this threshold; mirrored here
// for the blocking-time calculation (time over the 50ms budget).
const LONG_TASK_THRESHOLD_MS = 50

export type LongTaskSample = {
  // Task duration in ms as reported by the longtask entry.
  durationMs: number
  recordedAt: number
}

export type LongTaskSummary = {
  windowMs: number
  count: number
  // Sum of task durations in the window.
  totalMs: number
  // Total Blocking Time: sum of (duration - 50ms) over the window — the part
  // that actually blocks beyond the responsiveness budget.
  totalBlockingMs: number
  maxMs: number | null
  p95Ms: number | null
  lastAt: number | null
}

const samples: LongTaskSample[] = []
const listeners = new Set<() => void>()
let observer: { disconnect(): void } | null = null

function recordLongTask(durationMs: number, recordedAt = Date.now()): void {
  samples.push({ durationMs, recordedAt })
  if (samples.length > LONG_TASK_HISTORY_LIMIT) {
    samples.splice(0, samples.length - LONG_TASK_HISTORY_LIMIT)
  }
  for (const listener of listeners) listener()
}

export function getLongTaskSamples(): LongTaskSample[] {
  return [...samples]
}

// Starts the longtask PerformanceObserver once. Browser-only and best-effort:
// `longtask` is unsupported on some engines, in which case this is a no-op and
// the panel simply shows zero long tasks. Returns a stop function.
export function startLongTaskObserver(): () => void {
  if (observer) return () => {}
  if (typeof PerformanceObserver === 'undefined') return () => {}
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordLongTask(entry.duration)
    })
    obs.observe({ entryTypes: ['longtask'] })
    observer = obs
  } catch {
    return () => {}
  }
  return () => {
    observer?.disconnect()
    observer = null
  }
}

function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[index]
}

export function summarizeLongTasks(
  input: readonly LongTaskSample[],
  options: { windowMs?: number; now?: number } = {}
): LongTaskSummary {
  const now = options.now ?? Date.now()
  const windowMs = options.windowMs ?? 60_000
  const scoped = input.filter((sample) => now - sample.recordedAt <= windowMs)

  let totalMs = 0
  let totalBlockingMs = 0
  let maxMs: number | null = null
  let lastAt: number | null = null
  const durations: number[] = []
  for (const sample of scoped) {
    totalMs += sample.durationMs
    totalBlockingMs += Math.max(0, sample.durationMs - LONG_TASK_THRESHOLD_MS)
    maxMs = maxMs === null ? sample.durationMs : Math.max(maxMs, sample.durationMs)
    lastAt = lastAt === null ? sample.recordedAt : Math.max(lastAt, sample.recordedAt)
    durations.push(sample.durationMs)
  }
  durations.sort((a, b) => a - b)

  return {
    windowMs,
    count: scoped.length,
    totalMs: Math.round(totalMs),
    totalBlockingMs: Math.round(totalBlockingMs),
    maxMs: maxMs === null ? null : Math.round(maxMs),
    p95Ms: percentile(durations, 95),
    lastAt,
  }
}
