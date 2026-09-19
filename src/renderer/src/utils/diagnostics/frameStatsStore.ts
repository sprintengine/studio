// Frame-cadence monitor: measures the gap between animation frames via a
// requestAnimationFrame loop. Where longtask only flags monolithic >50ms
// main-thread tasks, this catches *per-frame* jank — the accumulated style /
// layout / pre-paint / compositing-update work the browser does every frame
// (e.g. maintaining many hidden workspace layers), which shows up as long
// frames and a depressed FPS without any single >50ms long task firing. That is
// exactly the class of jank the panel was previously blind to (0 long tasks
// during visibly janky scroll).
//
// Caveat to keep honest: rAF deltas measure *main-thread* frame cadence, which
// includes style/layout/pre-paint/compositing-input updates. It does NOT see
// pure GPU raster/draw stalls when the main thread is idle, so a compositor-only
// stall can be under-reported. It is the best in-renderer proxy short of
// DevTools' Performance panel.
//
// The store is a bounded ring; the summarizer is pure so it unit-tests without a
// browser. The monitor does not notify per frame (that would re-render the panel
// ~60×/s) — samples accumulate silently and the panel reads them on its existing
// 1s poll tick.

// ~10s of 60fps frames. Bounds the ring so an open panel can't grow it forever.
const FRAME_HISTORY_LIMIT = 600

// A frame slower than this is counted as a "long frame" (a clear stutter — at
// 60Hz this is ≥3 missed vsyncs). Subtler stutter is still visible via p95/max.
const LONG_FRAME_THRESHOLD_MS = 50

// Frames longer than this are treated as the tab being backgrounded / throttled
// (rAF is heavily clamped when hidden) and dropped rather than logged as jank.
const MAX_PLAUSIBLE_FRAME_MS = 5_000

export type FrameSample = {
  // Inter-frame delta in ms (time since the previous animation frame).
  durationMs: number
  recordedAt: number
}

export type FrameStatsSummary = {
  windowMs: number
  frameCount: number
  // Approximate average FPS over the window: 1000 / mean inter-frame delta.
  // Null when there are no frames in the window to average.
  fps: number | null
  // Frames over LONG_FRAME_THRESHOLD_MS in the window, and that as a percent of
  // frames sampled.
  longFrameCount: number
  longFramePercent: number
  maxMs: number | null
  p95Ms: number | null
  lastAt: number | null
}

const samples: FrameSample[] = []
let running = false
let rafHandle = 0

function recordFrame(durationMs: number, recordedAt = Date.now()): void {
  samples.push({ durationMs, recordedAt })
  if (samples.length > FRAME_HISTORY_LIMIT) {
    samples.splice(0, samples.length - FRAME_HISTORY_LIMIT)
  }
}

export function getFrameSamples(): FrameSample[] {
  return [...samples]
}

// Starts the rAF cadence loop once. Browser-only and best-effort; returns a stop
// function. Costs one subtraction + bounded array push per frame and nothing
// else, so it is safe to run while the panel is open.
export function startFrameMonitor(): () => void {
  if (running) return () => {}
  if (typeof requestAnimationFrame === 'undefined' || typeof performance === 'undefined') return () => {}
  running = true
  let last = performance.now()
  const tick = (timestamp: number): void => {
    const delta = timestamp - last
    last = timestamp
    // Skip the first/zero delta and tab-throttled gaps so they don't masquerade
    // as jank.
    if (delta > 0 && delta < MAX_PLAUSIBLE_FRAME_MS) recordFrame(delta)
    rafHandle = requestAnimationFrame(tick)
  }
  rafHandle = requestAnimationFrame(tick)
  return () => {
    running = false
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafHandle)
  }
}

function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[index]
}

export function summarizeFrameStats(
  input: readonly FrameSample[],
  options: { windowMs?: number; now?: number } = {},
): FrameStatsSummary {
  const now = options.now ?? Date.now()
  const windowMs = options.windowMs ?? 5_000
  const scoped = input.filter((sample) => now - sample.recordedAt <= windowMs)

  if (scoped.length === 0) {
    return {
      windowMs,
      frameCount: 0,
      fps: null,
      longFrameCount: 0,
      longFramePercent: 0,
      maxMs: null,
      p95Ms: null,
      lastAt: null,
    }
  }

  let total = 0
  let longFrameCount = 0
  let maxMs: number | null = null
  let lastAt: number | null = null
  const durations: number[] = []
  for (const sample of scoped) {
    total += sample.durationMs
    if (sample.durationMs > LONG_FRAME_THRESHOLD_MS) longFrameCount += 1
    maxMs = maxMs === null ? sample.durationMs : Math.max(maxMs, sample.durationMs)
    lastAt = lastAt === null ? sample.recordedAt : Math.max(lastAt, sample.recordedAt)
    durations.push(sample.durationMs)
  }
  durations.sort((a, b) => a - b)

  const meanDelta = total / scoped.length
  return {
    windowMs,
    frameCount: scoped.length,
    fps: meanDelta > 0 ? Math.round(1000 / meanDelta) : null,
    longFrameCount,
    longFramePercent: Math.round((longFrameCount / scoped.length) * 100),
    maxMs: maxMs === null ? null : Math.round(maxMs),
    p95Ms: percentile(durations, 95),
    lastAt,
  }
}
