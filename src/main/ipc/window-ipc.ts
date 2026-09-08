import { BrowserWindow, screen, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { safeExternalUrl } from './external-url'
import type { AuxWindowKind, OpenAuxWindowResult } from '../../shared/electron-api'

const AUX_WINDOW_KINDS: readonly AuxWindowKind[] = ['diff', 'file']

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
  confirmWindowClose(win: BrowserWindow): void
  openAuxWindow(input: {
    kind: AuxWindowKind
    singletonKey: string
    params: Record<string, string>
    bounds?: WindowBounds | null
  }): { retargeted: boolean }
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

  ipcMain.handle('window:confirm-close', (event) => {
    const win = getRequestWindow(event)
    if (win) options.confirmWindowClose(win)
  })

  ipcMain.handle('window:open-external', async (_event, url: unknown) => {
    const safe = safeExternalUrl(url)
    if (!safe.ok) return safe
    try {
      await shell.openExternal(safe.url)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not open link.' }
    }
  })

  ipcMain.handle('window:dock-file', (event, input: {
    workspaceId?: unknown
    path?: unknown
    name?: unknown
  }) => {
    const workspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId : ''
    const path = typeof input?.path === 'string' ? input.path : ''
    const name = typeof input?.name === 'string' ? input.name : ''
    if (!workspaceId || !path || !name) return
    // Broadcast to every other window; only the one whose model owns the
    // workspace acts on it (others no-op), so we avoid tracking window ownership.
    const sender = BrowserWindow.fromWebContents(event.sender)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win === sender || win.isDestroyed()) continue
      win.webContents.send('workspace:dock-file', { workspaceId, path, name })
    }
  })

  // The diff window's "Show in the app": same broadcast shape as a docked
  // file. Only the window whose model owns the workspace acts; the others
  // no-op, so no window ownership has to be tracked here.
  ipcMain.handle('window:dock-diff', (event, input: {
    workspaceId?: unknown
    repoRoot?: unknown
    focusPath?: unknown
    focusKind?: unknown
  }) => {
    const workspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId : ''
    const repoRoot = typeof input?.repoRoot === 'string' ? input.repoRoot : ''
    if (!workspaceId || !repoRoot) return
    const focusPath = typeof input?.focusPath === 'string' && input.focusPath ? input.focusPath : null
    const focusKind = input?.focusKind === 'staged' || input?.focusKind === 'unstaged' ? input.focusKind : null
    const sender = BrowserWindow.fromWebContents(event.sender)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win === sender || win.isDestroyed()) continue
      win.webContents.send('workspace:dock-diff', { workspaceId, repoRoot, focusPath, focusKind })
    }
  })

  ipcMain.handle('window:open-aux-window', (_event, input: {
    kind?: unknown
    singletonKey?: unknown
    params?: unknown
    bounds?: unknown
  }): OpenAuxWindowResult => {
    const kind = AUX_WINDOW_KINDS.find((candidate) => candidate === input?.kind)
    if (!kind) return { ok: false, message: 'invalid_aux_window_kind' }
    const singletonKey = typeof input?.singletonKey === 'string' ? input.singletonKey.trim() : ''
    if (!singletonKey) return { ok: false, message: 'missing_singleton_key' }
    const params = normalizeStringParams(input?.params)
    try {
      const { retargeted } = options.openAuxWindow({
        kind,
        singletonKey,
        params,
        bounds: normalizeWindowBounds(input?.bounds),
      })
      return { ok: true, retargeted }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'open_aux_window_failed',
      }
    }
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

function normalizeStringParams(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {}
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') params[key] = value
  }
  return params
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
