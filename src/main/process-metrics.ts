import type { ProcessMetricKind, ProcessMetricSample, ProcessMetricsSnapshot } from '../shared/electron-api'

// Electron's ProcessMetric.type strings, mapped to the role operators reason
// about. Browser is the main process; Tab is a window renderer.
function mapProcessKind(type: string): ProcessMetricKind {
  switch (type) {
    case 'Browser':
      return 'main'
    case 'Tab':
      return 'renderer'
    case 'GPU':
      return 'gpu'
    case 'Utility':
      return 'utility'
    default:
      return 'other'
  }
}

// The shape we depend on from Electron's app.getAppMetrics(). Declared locally
// (rather than importing Electron's ambient type) so this module unit-tests
// without an Electron runtime: the IPC layer passes app.getAppMetrics through.
export type RawProcessMetric = {
  pid: number
  type: string
  name?: string
  serviceName?: string
  cpu?: { percentCPUUsage?: number }
  // Electron reports memory in kilobytes.
  memory?: { workingSetSize?: number }
}

// V8 heap detail for the main process, read from process.memoryUsage() by the
// IPC handler (getAppMetrics does not carry it) and attached to the entry whose
// pid matches. Optional so the collector stays unit-testable without a runtime.
export type MainHeapUsage = {
  pid: number
  heapUsedBytes: number
  heapTotalBytes: number
}

export function collectProcessMetrics(
  getAppMetrics: () => RawProcessMetric[],
  now = Date.now(),
  mainHeap?: MainHeapUsage,
  // Per-pid OS thread counts, sampled out-of-band on a throttled cadence by the
  // IPC handler (getAppMetrics does not carry them). Optional so this stays
  // unit-testable and so the panel degrades to "—" when unavailable.
  threadCounts?: ReadonlyMap<number, number>,
  childProcesses: readonly ProcessMetricSample[] = []
): ProcessMetricsSnapshot {
  let raw: RawProcessMetric[]
  try {
    raw = getAppMetrics() ?? []
  } catch {
    // Best-effort: a runtime without app metrics degrades to "unavailable"
    // in the panel rather than crashing the IPC handler.
    return { sampledAt: now, processes: [] }
  }

  const processes: ProcessMetricSample[] = raw.map((metric) => {
    const name = metric.name?.trim() || metric.serviceName?.trim() || undefined
    const cpuPercent = Number.isFinite(metric.cpu?.percentCPUUsage)
      ? Math.max(0, Math.round((metric.cpu!.percentCPUUsage as number) * 10) / 10)
      : 0
    const workingSetKb = Number.isFinite(metric.memory?.workingSetSize)
      ? (metric.memory!.workingSetSize as number)
      : 0
    const heap = mainHeap && mainHeap.pid === metric.pid ? mainHeap : undefined
    const threads = threadCounts?.get(metric.pid)
    return {
      pid: metric.pid,
      kind: mapProcessKind(metric.type),
      type: metric.type,
      name,
      cpuPercent,
      memoryBytes: Math.max(0, workingSetKb) * 1024,
      // threads populated from the throttled OS sample when available;
      // fileDescriptors still omitted (see ProcessMetricSample in electron-api.ts).
      ...(threads !== undefined ? { threads } : {}),
      ...(heap ? { heapUsedBytes: heap.heapUsedBytes, heapTotalBytes: heap.heapTotalBytes } : {}),
    }
  })
  processes.push(...childProcesses)

  // Stable, scannable order: Electron internals first, then spawned work. Ties
  // are broken by CPU share and then RSS so hot or heavy children float up
  // within their kind.
  const kindOrder: Record<ProcessMetricKind, number> = {
    main: 0,
    renderer: 1,
    gpu: 2,
    utility: 3,
    agent: 4,
    terminal: 5,
    helper: 6,
    other: 7,
  }
  processes.sort((a, b) =>
    kindOrder[a.kind] - kindOrder[b.kind]
    || b.cpuPercent - a.cpuPercent
    || b.memoryBytes - a.memoryBytes
  )

  return { sampledAt: now, processes }
}
