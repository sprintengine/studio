import { app, type IpcMain } from 'electron'
import type {
  DiagnosticLogEntry,
  DiagnosticLogInput,
  ProcessMetricsSnapshot,
} from '../../shared/electron-api'
import { collectProcessMetrics, type RawProcessMetric } from '../process-metrics'
import { sampleThreadCounts, THREAD_SAMPLE_THROTTLE_MS } from '../thread-counts'

// Thread counts come from the OS (getAppMetrics has none), which on macOS means a
// `ps` spawn. To keep that off the 1s metrics poll, the latest counts are cached
// and refreshed at most once per THREAD_SAMPLE_THROTTLE_MS, asynchronously and
// fire-and-forget so the metrics response never waits on it. The poll attaches
// whatever is currently cached; counts lag by at most one throttle window, which
// is fine for a value that changes slowly.
let threadCountCache: ReadonlyMap<number, number> = new Map()
let threadCountSampledAt = 0
let threadCountSampleInFlight = false

function maybeRefreshThreadCounts(pids: readonly number[]): void {
  if (threadCountSampleInFlight) return
  if (Date.now() - threadCountSampledAt < THREAD_SAMPLE_THROTTLE_MS) return
  threadCountSampleInFlight = true
  void sampleThreadCounts(pids)
    .then((counts) => {
      threadCountCache = counts
      threadCountSampledAt = Date.now()
    })
    .catch(() => {
      // Best-effort: keep the last good counts on failure.
    })
    .finally(() => {
      threadCountSampleInFlight = false
    })
}

type DiagnosticsIpcDependencies = {
  writeDiagnosticLog(input: DiagnosticLogInput): Promise<DiagnosticLogEntry>
  openDiagnosticsLogsFolder(): Promise<{ opened: true; path: string }>
  openDiagnosticsWindow(): void
}

export function registerDiagnosticsIpc(
  ipcMain: IpcMain,
  deps: DiagnosticsIpcDependencies
): void {
  ipcMain.handle('diagnostics:log', async (_, input: DiagnosticLogInput) => {
    return deps.writeDiagnosticLog(input)
  })

  ipcMain.handle('diagnostics:open-logs-folder', async () => {
    return deps.openDiagnosticsLogsFolder()
  })

  // Request-only (no broadcast loop): the performance panel polls this ~once a
  // second while open and stops when it closes, so there is no main-process
  // cost while the panel is closed.
  ipcMain.handle('diagnostics:get-process-metrics', (): ProcessMetricsSnapshot => {
    // Attach the main process's V8 heap detail (getAppMetrics only carries the OS
    // working set). process.pid here is the Browser process, matching that entry's
    // pid so the collector merges it onto the right row.
    const heap = process.memoryUsage()
    // collectProcessMetrics owns the (safely guarded) getAppMetrics call; attach
    // the current thread-count cache, then refresh it off the hot path for the
    // next poll using the pids it actually returned.
    const snapshot = collectProcessMetrics(
      () => app.getAppMetrics() as unknown as RawProcessMetric[],
      Date.now(),
      { pid: process.pid, heapUsedBytes: heap.heapUsed, heapTotalBytes: heap.heapTotal },
      threadCountCache
    )
    maybeRefreshThreadCounts(snapshot.processes.map((metric) => metric.pid).filter((pid) => Number.isInteger(pid)))
    return snapshot
  })

  ipcMain.handle('diagnostics:open-window', () => {
    deps.openDiagnosticsWindow()
  })
}
