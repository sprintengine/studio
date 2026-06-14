import { app, type IpcMain } from 'electron'
import type {
  DiagnosticLogEntry,
  DiagnosticLogInput,
  ProcessMetricsSnapshot,
} from '../../shared/electron-api'
import { collectProcessMetrics, type RawProcessMetric } from '../process-metrics'

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
    return collectProcessMetrics(
      () => app.getAppMetrics() as unknown as RawProcessMetric[],
      Date.now(),
      { pid: process.pid, heapUsedBytes: heap.heapUsed, heapTotalBytes: heap.heapTotal }
    )
  })

  ipcMain.handle('diagnostics:open-window', () => {
    deps.openDiagnosticsWindow()
  })
}
