import type { IpcMain } from 'electron'

import type { AttachedFilePreview } from '../../shared/attached-files'
import type { AttachedFiles } from '../attached-files'
import { assertAppSender } from './ipc-sender'

// Files attached to a message by path (attached-files.ts). Registered on plain
// `ipcMain`, never the machine-aware wrapper: these are files on this computer,
// and opening one starts an app here. Each answers the app's own window only —
// an embedded page holding the preload must not grow the list or open from it.
export function registerAttachedFilesIpc(ipcMain: IpcMain, files: AttachedFiles): void {
  ipcMain.handle('attached-files:register', (event, path: unknown): void => {
    assertAppSender(event)
    files.register(path)
  })

  ipcMain.handle('attached-files:preview', async (event, path: unknown): Promise<AttachedFilePreview> => {
    assertAppSender(event)
    return files.preview(path)
  })

  ipcMain.handle('attached-files:open', async (event, path: unknown): Promise<void> => {
    assertAppSender(event)
    await files.open(path)
  })
}
