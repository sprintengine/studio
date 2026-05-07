import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { sendWindowState } from './ipc/window-ipc'

type CreateMainWindowOptions = {
  diagnosticsEnabled: boolean
}

export function createMainWindow({ diagnosticsEnabled }: CreateMainWindowOptions): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    ...(process.platform !== 'darwin'
      ? {
          frame: false,
        }
      : {}),
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())
  win.on('maximize', () => sendWindowState(win))
  win.on('unmaximize', () => sendWindowState(win))
  win.on('enter-full-screen', () => sendWindowState(win))
  win.on('leave-full-screen', () => sendWindowState(win))

  if (diagnosticsEnabled) {
    win.webContents.on('console-message', function (_event, detailsOrLevel) {
      const args = Array.from(arguments)
      const details = detailsOrLevel && typeof detailsOrLevel === 'object'
        ? detailsOrLevel as { level?: string; message?: string; sourceId?: string; lineNumber?: number }
        : null
      const level = details?.level ?? String(detailsOrLevel)
      const message = details?.message ?? String(args[2] ?? '')
      console.info(`[Renderer:${level}] ${message}`, {
        sourceId: details?.sourceId ?? args[4],
        line: details?.lineNumber ?? args[3],
      })
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Renderer] render-process-gone', details)
    })
    win.webContents.on('unresponsive', () => {
      console.error('[Renderer] unresponsive')
    })
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[Renderer] did-fail-load', { errorCode, errorDescription, validatedURL })
    })
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
