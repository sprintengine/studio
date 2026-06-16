import type { IpcMain } from 'electron'

import type { ColorScheme } from '../../shared/electron-api'
import { setColorScheme } from '../color-scheme-store'

// Kernel-level (not feature-owned) IPC: the renderer pushes its resolved color
// scheme here so main can launch agent CLIs matching the app's light/dark
// surface. The renderer owns the source of truth (the theme preference), so
// there's no read path back — main only caches the latest pushed value.
export function registerAppearanceIpc(ipcMain: IpcMain): void {
  ipcMain.handle('appearance:set-color-scheme', (_event, scheme: ColorScheme): void => {
    // Normalize defensively: any value that isn't an explicit 'light' falls back
    // to 'dark' rather than propagating a malformed scheme into a spawn argv.
    setColorScheme(scheme === 'light' ? 'light' : 'dark')
  })
}
