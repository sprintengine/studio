import { app, type IpcMain } from 'electron'
import type {
  DiagnosticLogEntry,
  DiagnosticLogInput,
  ProcessMetricSample,
  ProcessMetricsSnapshot,
  SystemMemorySample,
  WorkspaceMemorySample,
} from '../../shared/electron-api'
import { CHILD_PROCESS_SAMPLE_THROTTLE_MS, sampleChildProcessMetrics } from '../child-process-metrics'
import { collectProcessMetrics, type RawProcessMetric } from '../process-metrics'
import { sampleSystemMemory, SYSTEM_MEMORY_SAMPLE_THROTTLE_MS } from '../system-memory'
import { sampleThreadCounts, THREAD_SAMPLE_THROTTLE_MS } from '../thread-counts'
import { listTerminalRoots } from '../terminal-runtime'
import { listRecentReapEvents } from '../terminal-reap-log'
import { sampleWorkspaceMemory, WORKSPACE_MEMORY_SAMPLE_THROTTLE_MS, type TerminalRootInfo } from '../workspace-memory'

// Thread counts come from the OS (getAppMetrics has none), which on macOS means a
// `ps` spawn. To keep that off the 1s metrics poll, the latest counts are cached
// and refreshed at most once per THREAD_SAMPLE_THROTTLE_MS, asynchronously and
// fire-and-forget so the metrics response never waits on it. The poll attaches
// whatever is currently cached; counts lag by at most one throttle window, which
// is fine for a value that changes slowly.
let threadCountCache: ReadonlyMap<number, number> = new Map()
let threadCountSampledAt = 0
let threadCountSampleInFlight = false
let childProcessMetricCache: readonly ProcessMetricSample[] = []
let childProcessMetricSampledAt = 0
let childProcessMetricSampleInFlight = false
let systemMemoryCache: SystemMemorySample | undefined
let systemMemorySampledAt = 0
let systemMemorySampleInFlight = false
let workspaceMemoryCache: WorkspaceMemorySample[] = []
let workspaceMemorySampledAt = 0
let workspaceMemorySampleInFlight = false

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

function maybeRefreshSystemMemory(): void {
  if (systemMemorySampleInFlight) return
  if (Date.now() - systemMemorySampledAt < SYSTEM_MEMORY_SAMPLE_THROTTLE_MS) return
  systemMemorySampleInFlight = true
  void sampleSystemMemory()
    .then((sample) => {
      systemMemoryCache = sample
      systemMemorySampledAt = Date.now()
    })
    .catch(() => {
      // Best-effort: keep the last good system memory sample on failure.
    })
    .finally(() => {
      systemMemorySampleInFlight = false
    })
}

// Per-workspace RSS attribution. Like the child-process sampler this shells out
// to `ps`, so it is throttled and refreshed off the hot path; the poll attaches
// whatever is cached. Reads the live terminal roots each refresh so it tracks
// spawns/suspends.
function maybeRefreshWorkspaceMemory(): void {
  if (workspaceMemorySampleInFlight) return
  if (Date.now() - workspaceMemorySampledAt < WORKSPACE_MEMORY_SAMPLE_THROTTLE_MS) return
  workspaceMemorySampleInFlight = true
  void sampleWorkspaceMemory(collectAttributionRoots())
    .then((samples) => {
      workspaceMemoryCache = samples
      workspaceMemorySampledAt = Date.now()
    })
    .catch(() => {
      // Best-effort: keep the last good workspace-memory sample on failure.
    })
    .finally(() => {
      workspaceMemorySampleInFlight = false
    })
}

function maybeRefreshChildProcessMetrics(pids: readonly number[]): void {
  if (childProcessMetricSampleInFlight) return
  if (Date.now() - childProcessMetricSampledAt < CHILD_PROCESS_SAMPLE_THROTTLE_MS) return
  childProcessMetricSampleInFlight = true
  void sampleChildProcessMetrics(process.pid, pids)
    .then((metrics) => {
      childProcessMetricCache = metrics
      childProcessMetricSampledAt = Date.now()
    })
    .catch(() => {
      // Best-effort: keep the last good child process sample on failure.
    })
    .finally(() => {
      childProcessMetricSampleInFlight = false
    })
}

type DiagnosticsIpcDependencies = {
  writeDiagnosticLog(input: DiagnosticLogInput): Promise<DiagnosticLogEntry>
  openDiagnosticsLogsFolder(): Promise<{ opened: true; path: string }>
  openDiagnosticsWindow(): void
  // Headless conversation child processes (Claude SDK sessions) — shaped like
  // terminal roots so workspace-memory attribution covers them too.
  listConversationRoots?: () => TerminalRootInfo[]
}

let listConversationRootsDep: (() => TerminalRootInfo[]) | undefined

function collectAttributionRoots(): TerminalRootInfo[] {
  const conversationRoots = (() => {
    try {
      return listConversationRootsDep?.() ?? []
    } catch {
      return []
    }
  })()
  return [...listTerminalRoots(), ...conversationRoots]
}

export function registerDiagnosticsIpc(ipcMain: IpcMain, deps: DiagnosticsIpcDependencies): void {
  listConversationRootsDep = deps.listConversationRoots
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
    // the current OS-derived caches, then refresh them off the hot path for the
    // next poll using the Electron pids it actually returned.
    const snapshot = collectProcessMetrics(
      () => app.getAppMetrics() as unknown as RawProcessMetric[],
      Date.now(),
      { pid: process.pid, heapUsedBytes: heap.heapUsed, heapTotalBytes: heap.heapTotal },
      threadCountCache,
      childProcessMetricCache,
    )
    const electronPids = snapshot.processes
      .filter((metric) => metric.type !== 'Child')
      .map((metric) => metric.pid)
      .filter((pid) => Number.isInteger(pid))
    maybeRefreshThreadCounts(electronPids)
    maybeRefreshChildProcessMetrics(electronPids)
    maybeRefreshSystemMemory()
    maybeRefreshWorkspaceMemory()
    const reapEvents = listRecentReapEvents()
    return {
      ...snapshot,
      systemMemory: systemMemoryCache,
      workspaceMemory: workspaceMemoryCache,
      ...(reapEvents.length > 0 ? { reapEvents } : {}),
    }
  })

  ipcMain.handle('diagnostics:open-window', () => {
    deps.openDiagnosticsWindow()
  })
}
