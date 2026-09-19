import type { IpcMain } from 'electron'

import type { BackgroundModeStore } from '../background-mode-store'

/**
 * Push route for the "keep running in the background" setting. Same
 * contract as the appearance mirrors: the renderer owns the preference in
 * `appSettings`, main persists a copy so it can read it with no window open.
 * There is no read path back — main never writes this value, so a broadcast
 * would only create a second source of truth.
 */
export function registerBackgroundModeIpc(ipcMain: IpcMain, store: BackgroundModeStore): void {
  ipcMain.handle('app:set-background-mode', (_event, enabled: unknown): void => {
    store.set(enabled === true)
  })
}
