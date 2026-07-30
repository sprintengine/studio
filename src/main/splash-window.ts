import { BrowserWindow } from 'electron'
import { join } from 'path'
import type { SplashProgress } from '../shared/electron-api'

// The launch plate: a real second window that covers the gap between process
// start and the main window's first frame. `createMainWindow` builds the main
// window with `show: false` and only shows it on `ready-to-show`, so without
// this there is nothing on screen for the whole of bundle load.
//
// It is deliberately NOT a workspace window: no windowId, no workspace sync, no
// third-party modules, and — the point of the whole thing — no React bundle. It
// loads its own standalone `splash.html`, which is why it can paint while the
// bundle it is covering is still being parsed.
//
// Owner ruling 2026-07-30: prototype variant A, the quiet plate. It does not
// itemise what boot discovery found; the status line is the only read-out.
const SPLASH_WIDTH = 480
const SPLASH_HEIGHT = 320

// The plate's darkest base (--bg-app in the dark ramp). Painted by the OS from
// the first frame, so the ~395 KB backdrop decoding behind it never shows as a
// white rectangle. This is the "no white flash" guarantee, not a nicety.
const SPLASH_BACKGROUND_COLOR = '#08080c'

let splashWindow: BrowserWindow | null = null

// Never null: `new BrowserWindow` throws rather than returning nothing, and a
// nullable return would only buy a dead branch at the one call site.
export function createSplashWindow(): BrowserWindow {
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow

  const win = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    center: true,
    // frame:false on every platform is what keeps macOS traffic lights off it —
    // there is nothing to close, and closing it by hand would strand the boot.
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Shown immediately rather than on `ready-to-show`: with backgroundColor set
    // the OS paints the plate's base colour on the very first frame, so the
    // brand moment starts now instead of after the HTML parses. Waiting for
    // ready-to-show would reintroduce a (shorter) window of nothing on screen,
    // which is exactly what this window exists to remove.
    show: true,
    backgroundColor: SPLASH_BACKGROUND_COLOR,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })
  splashWindow = win

  win.on('closed', () => {
    if (splashWindow === win) splashWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(new URL('splash.html', process.env['ELECTRON_RENDERER_URL']).toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/splash.html'))
  }

  return win
}

// Pushes one status line + hairline position at the splash. A no-op once the
// splash is gone, so a boot-discovery leg that resolves after the reveal (a slow
// CLI probe on a machine that hydrated fast) is not an error path.
export function sendSplashProgress(update: SplashProgress): void {
  const win = splashWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send('splash:progress', update)
}

// Idempotent: the reveal path and the timeout path both call it, and whichever
// loses the race must not throw. `destroy()` rather than `close()` — this window
// has no unsaved state and no close guard, and destroy cannot be vetoed.
export function closeSplashWindow(): void {
  const win = splashWindow
  splashWindow = null
  if (!win || win.isDestroyed()) return
  win.destroy()
}

export function isSplashOpen(): boolean {
  return splashWindow !== null && !splashWindow.isDestroyed()
}
