import { BrowserWindow, screen, type IpcMain, type IpcMainInvokeEvent } from 'electron'

type WindowState = {
  isMaximized: boolean
  isFullScreen: boolean
}

type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

type WindowPlacement = {
  bounds: WindowBounds
  isMaximized: boolean
  displayId: number | null
}

function getWindowState(win: BrowserWindow): WindowState {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  }
}

function getWindowPlacement(win: BrowserWindow): WindowPlacement {
  const bounds = win.getNormalBounds()
  return {
    bounds,
    isMaximized: win.isMaximized(),
    displayId: screen.getDisplayMatching(bounds)?.id ?? null,
  }
}

export function sendWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:state-changed', getWindowState(win))
}

export function sendWindowPlacement(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:placement-changed', getWindowPlacement(win))
}

function getRequestWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return null
  return win
}

type RegisterWindowIpcOptions = {
  createWorkspaceWindow(input: {
    windowId: string
    bounds?: WindowBounds | null
    isMaximized?: boolean
  }): void
}

function getWorkspaceWindowId(win: BrowserWindow): string {
  try {
    const currentUrl = win.webContents.getURL()
    const parsed = new URL(currentUrl)
    return parsed.searchParams.get('windowId')?.trim() || 'primary'
  } catch {
    return 'primary'
  }
}

export function registerWindowIpc(ipcMain: IpcMain, options: RegisterWindowIpcOptions): void {
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

  ipcMain.handle('window:get-placement', (event) => {
    const win = getRequestWindow(event)
    return win ? getWindowPlacement(win) : null
  })

  ipcMain.handle('window:get-workspace-window-id', (event) => {
    const win = getRequestWindow(event)
    return win ? getWorkspaceWindowId(win) : 'primary'
  })

  ipcMain.handle('window:create-workspace-window', (_event, input: {
    windowId?: unknown
    bounds?: unknown
    isMaximized?: unknown
  }) => {
    const windowId = typeof input?.windowId === 'string' ? input.windowId.trim() : ''
    if (!windowId) return { ok: false, message: 'missing_window_id' }
    try {
      options.createWorkspaceWindow({
        windowId,
        bounds: normalizeWindowBounds(input.bounds),
        isMaximized: input.isMaximized === true,
      })
      return { ok: true, windowId }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'create_window_failed',
      }
    }
  })
}

function normalizeWindowBounds(input: unknown): WindowBounds | null {
  if (!input || typeof input !== 'object') return null
  const bounds = input as Partial<WindowBounds>
  const x = bounds.x
  const y = bounds.y
  const width = bounds.width
  const height = bounds.height
  if (
    typeof x !== 'number'
    || typeof y !== 'number'
    || typeof width !== 'number'
    || typeof height !== 'number'
    || !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(width)
    || !Number.isFinite(height)
  ) {
    return null
  }
  return { x, y, width, height }
}
