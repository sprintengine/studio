import type { IpcMain } from 'electron'

import type { KeepAwakeStore } from '../keep-awake-store'

/**
 * Settings' read and write of "Keep the computer awake while agents work".
 * Main owns the value (keep-awake-store.ts), so both answer with what main now
 * holds; a write is applied at once (`onChange`), taking or releasing the
 * blocker for the agents already working.
 */
export function registerKeepAwakeIpc(ipcMain: IpcMain, store: KeepAwakeStore, onChange: () => void): void {
  ipcMain.handle('app:get-keep-awake', (): boolean => store.isEnabled())
  ipcMain.handle('app:set-keep-awake', (_event, enabled: unknown): boolean => {
    store.set(enabled === true)
    onChange()
    return store.isEnabled()
  })
}
