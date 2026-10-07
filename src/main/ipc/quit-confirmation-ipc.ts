import type { IpcMain } from 'electron'

import type { QuitConfirmationStore } from '../quit-confirmation-store'

/**
 * Settings' read and write of "Ask before quitting while agents are working".
 * Main owns the value (quit-confirmation-store.ts), so both answer with what
 * main now holds.
 */
export function registerQuitConfirmationIpc(ipcMain: IpcMain, store: QuitConfirmationStore): void {
  ipcMain.handle('app:get-quit-confirmation', (): boolean => store.isEnabled())
  ipcMain.handle('app:set-quit-confirmation', (_event, enabled: unknown): boolean => {
    store.set(enabled === true)
    return store.isEnabled()
  })
}
