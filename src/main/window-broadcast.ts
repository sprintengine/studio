import { BrowserWindow } from 'electron'

import { isCanvasWorkerWindow } from './canvas/canvas-worker-window'

// Main → every window, and "is any window focused": the two questions a dozen
// services asked `BrowserWindow.getAllWindows()` themselves. Kept apart from
// window-factory so a small service can push without importing everything a
// window is built from.
//
// For the workspace windows alone (not Diagnostics, an aux view or the canvas
// worker) use `broadcastToWorkspaceWindows` in window-factory instead.

export type AllWindowsOptions = {
  /**
   * Leave out the hidden canvas worker window, which has no one looking at it:
   * for a push only a person would act on, or focus a person would give.
   */
  skipCanvasWorker?: boolean
}

function liveWindows(options: AllWindowsOptions): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) =>
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      !(options.skipCanvasWorker && isCanvasWorkerWindow(window)),
  )
}

/** Send `payload` on `channel` to every live window. */
export function broadcastToAllWindows(channel: string, payload?: unknown, options: AllWindowsOptions = {}): void {
  for (const window of liveWindows(options)) window.webContents.send(channel, payload)
}

/** Whether any live window has the focus, i.e. the app is the one in front. */
export function anyWindowFocused(options: AllWindowsOptions = {}): boolean {
  return liveWindows(options).some((window) => window.isFocused())
}
