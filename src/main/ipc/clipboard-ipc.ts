import { clipboard, type IpcMain } from 'electron'

export function registerClipboardIpc(ipcMain: IpcMain): void {
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string') {
      throw new TypeError('clipboard:write-text expects a string payload')
    }
    clipboard.writeText(text)
  })
}
