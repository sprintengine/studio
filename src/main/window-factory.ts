import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { sendWindowPlacement, sendWindowState } from './ipc/window-ipc'

type CreateMainWindowOptions = {
  diagnosticsEnabled: boolean
  windowId?: string
  bounds?: { x: number; y: number; width: number; height: number } | null
  isMaximized?: boolean
}

const forceCloseWindowIds = new WeakSet<BrowserWindow>()
let appQuitInProgress = false

export function markAppQuitInProgressForWindowClose(): void {
  appQuitInProgress = true
}

export function confirmWorkspaceWindowClose(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  forceCloseWindowIds.add(win)
  win.close()
}

export function createMainWindow({
  diagnosticsEnabled,
  windowId = 'primary',
  bounds = null,
  isMaximized = false,
}: CreateMainWindowOptions): BrowserWindow {
  const safeBounds = normalizeWindowBounds(bounds)
  const win = new BrowserWindow({
    width: safeBounds?.width ?? 1400,
    height: safeBounds?.height ?? 900,
    ...(safeBounds ? { x: safeBounds.x, y: safeBounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    show: false,
    ...(process.platform !== 'darwin'
      ? {
          frame: false,
        }
      : {
          // Keep the native traffic lights but hide the OS title bar so the
          // renderer can draw its own draggable title strip (centered brand).
          titleBarStyle: 'hiddenInset' as const,
          // Vertically center the traffic lights in the 36 px title strip
          // (`AppTitleBar`) so they line up with the centered brand.
          trafficLightPosition: { x: 12, y: 11 },
        }),
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => {
    if (isMaximized) win.maximize()
    win.show()
    win.focus()
  })
  win.on('maximize', () => {
    sendWindowState(win)
    sendWindowPlacement(win)
  })
  win.on('unmaximize', () => {
    sendWindowState(win)
    sendWindowPlacement(win)
  })
  win.on('enter-full-screen', () => sendWindowState(win))
  win.on('leave-full-screen', () => sendWindowState(win))
  const schedulePlacementUpdate = createPlacementUpdateScheduler(win)
  win.on('move', schedulePlacementUpdate)
  win.on('resize', schedulePlacementUpdate)
  win.on('focus', () => sendWindowPlacement(win))
  win.on('close', (event) => {
    if (windowId === 'primary' || appQuitInProgress || forceCloseWindowIds.has(win)) return
    event.preventDefault()
    win.webContents.send('window:close-requested')
  })

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

  // Voice dictation captures the microphone via getUserMedia in the renderer.
  // Grant the media permission for this trusted first-party window (the OS still
  // gates the actual microphone via its own permission prompt on macOS/Windows).
  const grantMedia = (permission: string): boolean => permission === 'media' || permission === 'audioCapture'
  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(grantMedia(permission))
  })
  win.webContents.session.setPermissionCheckHandler((_webContents, permission) => grantMedia(permission))

  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('windowId', windowId)
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { windowId },
    })
  }

  return win
}

function createPlacementUpdateScheduler(win: BrowserWindow): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      sendWindowPlacement(win)
    }, 250)
  }
}

function normalizeWindowBounds(
  bounds: { x: number; y: number; width: number; height: number } | null | undefined
): { x: number; y: number; width: number; height: number } | null {
  if (!bounds) return null
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every(Number.isFinite)) return null
  const next = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(800, Math.round(width)),
    height: Math.max(600, Math.round(height)),
  }
  const display = screen.getDisplayMatching(next)
  const area = display.workArea
  return {
    ...next,
    x: Math.min(Math.max(next.x, area.x), area.x + Math.max(0, area.width - next.width)),
    y: Math.min(Math.max(next.y, area.y), area.y + Math.max(0, area.height - next.height)),
  }
}
