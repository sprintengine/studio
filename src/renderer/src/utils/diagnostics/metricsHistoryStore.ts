import type { ProcessMetricsSnapshot } from '../../../../shared/electron-api'

// Renderer-local rolling history of process metrics, appended once per poll. Two
// things the point-in-time snapshot can't give: a short time-series (sparklines)
// and a "mark baseline → diff" so a change's before/after is measurable in-app
// instead of eyeballing two copied reports. Bounded so an open panel can't grow
// it without limit (300 samples ≈ 5 min at the 1s poll).
export const METRICS_HISTORY_LIMIT = 300
export const GROWTH_WINDOW_MS = 120_000

// JS heap snapshot read from the renderer's non-standard `performance.memory`
// (Chromium-only). Read at the callsite and passed in so this module stays pure.
export type RendererHeap = { usedBytes: number; totalBytes: number }

export type MetricsSample = {
  sampledAt: number
  rendererCpuPercent: number
  rendererRssBytes: number
  mainCpuPercent: number
  mainRssBytes: number
  gpuRssBytes: number
  totalRssBytes: number
  rendererHeapUsedBytes: number | null
  rendererHeapTotalBytes: number | null
}

export type MetricsDiff = {
  elapsedMs: number
  rendererCpuPercent: number
  rendererRssBytes: number
  mainRssBytes: number
  totalRssBytes: number
  rendererHeapUsedBytes: number | null
}

export type GrowthRates = {
  windowMs: number
  sampleCount: number
  // Linear (last − first) / elapsed, scaled to bytes per minute. Null when there
  // are fewer than two samples in the window to draw a slope from.
  rssBytesPerMin: number | null
  heapBytesPerMin: number | null
}

// Sum each process kind across all instances (there can be several renderers /
// utilities). Totals are the headline; per-kind drives the sparklines.
export function deriveMetricsSample(
  snapshot: ProcessMetricsSnapshot,
  heap: RendererHeap | null
): MetricsSample {
  let rendererCpuPercent = 0
  let rendererRssBytes = 0
  let mainCpuPercent = 0
  let mainRssBytes = 0
  let gpuRssBytes = 0
  let totalRssBytes = 0
  for (const process of snapshot.processes) {
    totalRssBytes += process.memoryBytes
    if (process.kind === 'renderer') {
      rendererCpuPercent += process.cpuPercent
      rendererRssBytes += process.memoryBytes
    } else if (process.kind === 'main') {
      mainCpuPercent += process.cpuPercent
      mainRssBytes += process.memoryBytes
    } else if (process.kind === 'gpu') {
      gpuRssBytes += process.memoryBytes
    }
  }
  return {
    sampledAt: snapshot.sampledAt,
    rendererCpuPercent: Math.round(rendererCpuPercent * 10) / 10,
    rendererRssBytes,
    mainCpuPercent: Math.round(mainCpuPercent * 10) / 10,
    mainRssBytes,
    gpuRssBytes,
    totalRssBytes,
    rendererHeapUsedBytes: heap?.usedBytes ?? null,
    rendererHeapTotalBytes: heap?.totalBytes ?? null,
  }
}

export function diffMetricsSamples(baseline: MetricsSample, current: MetricsSample): MetricsDiff {
  return {
    elapsedMs: current.sampledAt - baseline.sampledAt,
    rendererCpuPercent: Math.round((current.rendererCpuPercent - baseline.rendererCpuPercent) * 10) / 10,
    rendererRssBytes: current.rendererRssBytes - baseline.rendererRssBytes,
    mainRssBytes: current.mainRssBytes - baseline.mainRssBytes,
    totalRssBytes: current.totalRssBytes - baseline.totalRssBytes,
    rendererHeapUsedBytes:
      current.rendererHeapUsedBytes !== null && baseline.rendererHeapUsedBytes !== null
        ? current.rendererHeapUsedBytes - baseline.rendererHeapUsedBytes
        : null,
  }
}

// Slope over the window as bytes/min — a sustained positive RSS/heap slope under
// steady workload is the leak signal. First-vs-last keeps it cheap and obvious.
export function computeGrowthRates(
  input: readonly MetricsSample[],
  options: { windowMs?: number; now?: number } = {}
): GrowthRates {
  const now = options.now ?? Date.now()
  const windowMs = options.windowMs ?? GROWTH_WINDOW_MS
  const scoped = input.filter((sample) => now - sample.sampledAt <= windowMs)
  if (scoped.length < 2) {
    return { windowMs, sampleCount: scoped.length, rssBytesPerMin: null, heapBytesPerMin: null }
  }
  const first = scoped[0]
  const last = scoped[scoped.length - 1]
  const elapsedMin = (last.sampledAt - first.sampledAt) / 60_000
  if (elapsedMin <= 0) {
    return { windowMs, sampleCount: scoped.length, rssBytesPerMin: null, heapBytesPerMin: null }
  }
  const rssBytesPerMin = Math.round((last.totalRssBytes - first.totalRssBytes) / elapsedMin)
  const heapBytesPerMin =
    last.rendererHeapUsedBytes !== null && first.rendererHeapUsedBytes !== null
      ? Math.round((last.rendererHeapUsedBytes - first.rendererHeapUsedBytes) / elapsedMin)
      : null
  return { windowMs, sampleCount: scoped.length, rssBytesPerMin, heapBytesPerMin }
}

const samples: MetricsSample[] = []
let baseline: MetricsSample | null = null
const listeners = new Set<() => void>()

export function appendMetricsSample(sample: MetricsSample): void {
  samples.push(sample)
  if (samples.length > METRICS_HISTORY_LIMIT) {
    samples.splice(0, samples.length - METRICS_HISTORY_LIMIT)
  }
  for (const listener of listeners) listener()
}

export function getMetricsHistory(): MetricsSample[] {
  return [...samples]
}

export function setMetricsBaseline(sample: MetricsSample | null): void {
  baseline = sample
  for (const listener of listeners) listener()
}

export function getMetricsBaseline(): MetricsSample | null {
  return baseline
}

export function subscribeMetricsHistory(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Reads the renderer's non-standard heap counters when present (Chromium). Kept
// here so the component does not repeat the `performance.memory` shape guard.
export function readRendererHeap(): RendererHeap | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } }).memory
  if (!memory || typeof memory.usedJSHeapSize !== 'number' || typeof memory.totalJSHeapSize !== 'number') return null
  return { usedBytes: memory.usedJSHeapSize, totalBytes: memory.totalJSHeapSize }
}
