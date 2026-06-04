import type { IpcMain } from 'electron'

import type { PluginRegistryListResult } from '../../shared/electron-api'
import { listPluginRegistryEntries } from '../plugin-registry-instance'

export type PluginIpcHandlers = {
  list(): PluginRegistryListResult
}

export function createPluginIpcHandlers(): PluginIpcHandlers {
  return {
    list(): PluginRegistryListResult {
      try {
        return { ok: true, plugins: listPluginRegistryEntries() }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  }
}

export function registerPluginIpc(
  ipcMain: IpcMain,
  handlers: PluginIpcHandlers = createPluginIpcHandlers()
): void {
  ipcMain.handle('plugins:list', async (): Promise<PluginRegistryListResult> => {
    try {
      return handlers.list()
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
