import type { IpcMain } from 'electron'
import type { MultiloopInitInput, MultiloopInitResult } from '../../shared/electron-api'

type MultiloopIpcDependencies = {
  initializeMultiloopState(payload: MultiloopInitInput): Promise<MultiloopInitResult>
}

export function registerMultiloopIpc(ipcMain: IpcMain, deps: MultiloopIpcDependencies): void {
  ipcMain.handle('multiloop:init', async (_, payload: MultiloopInitInput): Promise<MultiloopInitResult> => {
    return deps.initializeMultiloopState(payload)
  })
}
