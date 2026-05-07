import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'

type WindowState = {
  isMaximized: boolean
  isFullScreen: boolean
}

function getWindowState(win: BrowserWindow): WindowState {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  }
}

export function sendWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:state-changed', getWindowState(win))
}

function getRequestWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return null
  return win
}

export function registerWindowIpc(ipcMain: IpcMain): void {
  ipcMain.handle('window:minimize', (event) => {
    getRequestWindow(event)?.minimize()
  })

  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = getRequestWindow(event)
    if (!win) return null

    if (win.isFullScreen()) {
      win.setFullScreen(false)
    } else if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }

    return getWindowState(win)
  })

  ipcMain.handle('window:close', (event) => {
    getRequestWindow(event)?.close()
  })

  ipcMain.handle('window:get-state', (event) => {
    const win = getRequestWindow(event)
    return win ? getWindowState(win) : null
  })
}
