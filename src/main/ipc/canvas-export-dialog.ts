import { BrowserWindow, app, dialog, shell, type OpenDialogOptions, type WebContents } from 'electron'

import { resolveTestOpenDirOverride } from './menu-dialog-ipc'

/**
 * The folder a board is exported into, chosen by the person in the system's
 * own picker. Main shows it, not the renderer: the folder an export writes into
 * is then one the person pointed at, never a path a renderer handed over.
 * Null when the picker was dismissed.
 */
export async function pickCanvasExportDirectory(sender: WebContents, defaultPath?: string): Promise<string | null> {
  // The same override the Open Folder picker honours, so an end-to-end run can
  // drive an export without a native dialog it cannot click.
  const testOverride = await resolveTestOpenDirOverride({ isPackaged: app.isPackaged })
  if (testOverride) return testOverride

  const win = BrowserWindow.fromWebContents(sender)
  const options: OpenDialogOptions = {
    title: 'Export board to folder',
    buttonLabel: 'Export',
    properties: process.platform === 'darwin' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    ...(typeof defaultPath === 'string' && defaultPath.trim() ? { defaultPath } : {}),
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/**
 * Show a board file in the system file manager. The path comes from main, never
 * from the renderer: a store board lives in the app's data folder, which the
 * renderer has no way to spell.
 */
export function revealCanvasBoardFile(absolutePath: string): void {
  shell.showItemInFolder(absolutePath)
}
