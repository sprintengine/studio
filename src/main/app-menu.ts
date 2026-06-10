import { BrowserWindow, Menu, type IpcMain } from 'electron'
import type { AppMenuAcceleratorUpdate, AppMenuAcceleratorUpdateResult } from '../shared/electron-api'

const MENU_ACCELERATOR_COMMAND_IDS = new Set([
  'app.settings.open',
  'panel.files.toggle',
  'panel.editor.toggle',
  'panel.git.toggle',
  'panel.knowledge-graph.toggle',
])

const menuAcceleratorOverrides = new Map<string, string | null>()

function sendMenuCommand(win: Electron.BaseWindow | null, command: string): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.send('app-menu:command', command)
}

function zoomFocusedWindowIn(win: Electron.BaseWindow | null): void {
  if (!win || win.isDestroyed()) return
  const browserWindow = BrowserWindow.fromId(win.id)
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.setZoomLevel(browserWindow.webContents.getZoomLevel() + 0.5)
}

// `fallback` is the command's default keybinding; omit it for commands that
// ship unbound (the menu item then only shows a user-bound shortcut).
function menuAccelerator(commandId: string, fallback?: string): string | undefined {
  if (menuAcceleratorOverrides.has(commandId)) {
    return menuAcceleratorOverrides.get(commandId) ?? undefined
  }
  return fallback
}

function sanitizeAcceleratorUpdate(input: unknown): AppMenuAcceleratorUpdate | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (typeof record.commandId !== 'string') return null
  if (!MENU_ACCELERATOR_COMMAND_IDS.has(record.commandId)) return null
  if (record.accelerator !== null && typeof record.accelerator !== 'string') return null
  if (typeof record.accelerator === 'string' && record.accelerator.length > 80) return null
  return {
    commandId: record.commandId,
    accelerator: record.accelerator,
  }
}

export function registerAppMenuIpc(ipcMain: IpcMain): void {
  ipcMain.handle('app-menu:update-accelerators', (_event, input: unknown): AppMenuAcceleratorUpdateResult => {
    if (!Array.isArray(input)) return { ok: true }
    for (const item of input) {
      const update = sanitizeAcceleratorUpdate(item)
      if (!update) continue
      menuAcceleratorOverrides.set(update.commandId, update.accelerator)
    }
    Menu.setApplicationMenu(createAppMenu())
    return { ok: true }
  })
}

export function createAppMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          accelerator: menuAccelerator('app.settings.open', 'CmdOrCtrl+,'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'app.settings.open'),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle File Explorer',
          accelerator: menuAccelerator('panel.files.toggle', 'CmdOrCtrl+Shift+E'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'panel.files.toggle'),
        },
        {
          label: 'Toggle Code Editor',
          accelerator: menuAccelerator('panel.editor.toggle', 'CmdOrCtrl+Shift+O'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'panel.editor.toggle'),
        },
        {
          label: 'Toggle Git Panel',
          accelerator: menuAccelerator('panel.git.toggle', 'CmdOrCtrl+Shift+G'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'panel.git.toggle'),
        },
        {
          label: 'Toggle Knowledge Graph',
          accelerator: menuAccelerator('panel.knowledge-graph.toggle'),
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'panel.knowledge-graph.toggle'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: (_, win) => zoomFocusedWindowIn(win ?? BrowserWindow.getFocusedWindow()),
        },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check For Updates',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'app.updates.check'),
        },
        {
          label: 'About Multicode',
          click: (_, win) => sendMenuCommand(win ?? BrowserWindow.getFocusedWindow(), 'show-about'),
        },
      ],
    },
  ])
}
