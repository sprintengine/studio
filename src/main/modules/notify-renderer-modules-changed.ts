import { BrowserWindow } from 'electron'

/** Installed/trusted files are ready to rediscover; no executable code here. */
export function notifyRendererModulesChanged(windows = BrowserWindow.getAllWindows()): void {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send('modules:third-party:changed')
    } catch (error) {
      // A window closing during fan-out must never turn a committed install
      // into a reported failure or prevent the other windows from refreshing.
      console.warn('[modules] could not notify renderer of installed modules:', error)
    }
  }
}
