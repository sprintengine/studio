import type { IpcMain } from 'electron'
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../../shared/electron-api'

type DiagnosticsIpcDependencies = {
  writeDiagnosticLog(input: DiagnosticLogInput): Promise<DiagnosticLogEntry>
  openDiagnosticsLogsFolder(): Promise<{ opened: true; path: string }>
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
}
