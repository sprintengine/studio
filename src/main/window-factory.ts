import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import type { WindowMaterial } from '../shared/electron-api'
import { sendWindowPlacement, sendWindowState } from './ipc/window-ipc'
import { getWindowMaterial } from './window-material-store'

type CreateMainWindowOptions = {
  diagnosticsEnabled: boolean
  windowId?: string
  bounds?: { x: number; y: number; width: number; height: number } | null
  isMaximized?: boolean
}

const forceCloseWindowIds = new WeakSet<BrowserWindow>()
let appQuitInProgress = false
// Persisted detached workspace windows are restored exactly ONCE per process —
// on the genuine cold-start primary. Consumed by the first primary window
// created; every later primary (notably the one macOS `activate` re-creates
// after all windows were closed) is handed restoreDetached=0, so closing your
// windows can never be silently undone by an auto-respawn (which read as an
// un-closable window that respawned on every close).
let detachedRestorePending = true

// Workspace (main-shell) windows only — aux/diagnostics windows never frost.
// The material IPC re-applies vibrancy live to every member on change.
const workspaceWindows = new Set<BrowserWindow>()

const SOLID_BACKGROUND_COLOR = '#09090b'

// macOS vibrancy for the glass window material. The OS composites the blur
// from the desktop BEHIND the window (never from our own content), so this is
// frame-budget-free even with streaming terminals — unlike in-app
// backdrop-filter, which stays banned (see .overlay-scrim in index.css).
// Which regions read as glass is the renderer's call via the
// data-window-material attribute; everything painted opaque stays opaque.
export function applyWindowMaterialToWorkspaceWindows(material: WindowMaterial): void {
  if (process.platform !== 'darwin') return
  for (const win of workspaceWindows) {
    if (win.isDestroyed()) continue
    win.setVibrancy(material === 'glass' ? 'under-window' : null)
    win.setBackgroundColor(material === 'glass' ? '#00000000' : SOLID_BACKGROUND_COLOR)
  }
}

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
  // Consume the one-shot: only the first primary window of the process is
  // eligible to restore detached windows. Detached windows (windowId !==
  // 'primary') never restore, so they leave the flag alone.
  const restoreDetached = windowId === 'primary' && detachedRestorePending
  if (windowId === 'primary') detachedRestorePending = false
  // Applied at creation (not post-boot) so a glass-persisted profile paints
  // frosted chrome from the first frame; getWindowMaterial() is 'solid'
  // everywhere but macOS. The renderer boot script stamps the matching
  // data-window-material attribute just as synchronously.
  const glass = getWindowMaterial() === 'glass'
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
    ...(glass
      ? { vibrancy: 'under-window' as const, backgroundColor: '#00000000' }
      : { backgroundColor: SOLID_BACKGROUND_COLOR }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Sprint Engine auto-run (sprint-runtime-ownership Phase 2): the run
      // scheduler lives in main and is immune to occlusion throttling, but
      // workspace windows still host terminal views, projection polling, and
      // session reconcile passes. A locked screen occludes the window and
      // Chromium background-throttles its timers to ~1/min, which stalled
      // those views mid-run. The window's periodic work already quiesces
      // when idle (registered pollers unregister), so disabling throttling
      // does not burn CPU on dormant workspaces.
      backgroundThrottling: false,
    },
  })

  workspaceWindows.add(win)
  win.on('closed', () => {
    workspaceWindows.delete(win)
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
    url.searchParams.set('restoreDetached', restoreDetached ? '1' : '0')
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { windowId, restoreDetached: restoreDetached ? '1' : '0' },
    })
  }

  return win
}

// Singleton standalone diagnostics window. Loads the same renderer bundle with
// `?view=diagnostics` so the renderer mounts only the performance panel. It is
// deliberately not a workspace window: it does not participate in workspace
// sync, carries no `windowId`, and closes normally (no unsaved-work guard).
let diagnosticsWindow: BrowserWindow | null = null

export function createDiagnosticsWindow(): BrowserWindow {
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) {
    if (diagnosticsWindow.isMinimized()) diagnosticsWindow.restore()
    diagnosticsWindow.focus()
    return diagnosticsWindow
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 600,
    minHeight: 400,
    show: false,
    title: 'Sprint Engine Studio Diagnostics',
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })
  diagnosticsWindow = win

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    if (diagnosticsWindow === win) diagnosticsWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('view', 'diagnostics')
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'diagnostics' },
    })
  }

  return win
}

// Lightweight auxiliary windows (diff viewer, external file editor). They share
// the main window's chrome treatment but mount a dedicated renderer root via the
// `aux=<kind>` query param — no workspace shell, no workspace-window sync. Keyed
// by `<kind>:<singletonKey>` so a repeat request reuses (retargets + focuses)
// the existing window rather than spawning a duplicate.
const auxWindows = new Map<string, BrowserWindow>()

export type AuxWindowKind = 'diff' | 'file'

type CreateAuxWindowOptions = {
  kind: AuxWindowKind
  singletonKey: string
  params: Record<string, string>
  bounds?: { x: number; y: number; width: number; height: number } | null
}

export function openAuxWindow({
  kind,
  singletonKey,
  params,
  bounds = null,
}: CreateAuxWindowOptions): { retargeted: boolean } {
  const registryKey = `${kind}:${singletonKey}`
  const existing = auxWindows.get(registryKey)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.webContents.send('aux:retarget', { kind, params })
    existing.focus()
    return { retargeted: true }
  }

  const safeBounds = normalizeWindowBounds(bounds)
  const win = new BrowserWindow({
    width: safeBounds?.width ?? 1100,
    height: safeBounds?.height ?? 720,
    ...(safeBounds ? { x: safeBounds.x, y: safeBounds.y } : {}),
    minWidth: 700,
    minHeight: 480,
    show: false,
    ...(process.platform !== 'darwin'
      ? { frame: false }
      : {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 11 },
        }),
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Sprint Engine auto-run (sprint-runtime-ownership Phase 2): the run
      // scheduler lives in main and is immune to occlusion throttling, but
      // workspace windows still host terminal views, projection polling, and
      // session reconcile passes. A locked screen occludes the window and
      // Chromium background-throttles its timers to ~1/min, which stalled
      // those views mid-run. The window's periodic work already quiesces
      // when idle (registered pollers unregister), so disabling throttling
      // does not burn CPU on dormant workspaces.
      backgroundThrottling: false,
    },
  })
  auxWindows.set(registryKey, win)

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    if (auxWindows.get(registryKey) === win) auxWindows.delete(registryKey)
  })

  const schedulePlacementUpdate = createPlacementUpdateScheduler(win)
  win.on('move', schedulePlacementUpdate)
  win.on('resize', schedulePlacementUpdate)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const query: Record<string, string> = { aux: kind, ...params }
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('aux', kind)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  return { retargeted: false }
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
