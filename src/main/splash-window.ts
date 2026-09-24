import { BrowserWindow } from 'electron'
import { join } from 'path'
import type { AppUpdateTrack, SplashProgress } from '../shared/electron-api'

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

/**
 * The query the splash document is loaded with. A nightly build opens on its
 * own plate (a night sky, the mark on a bezelled tile, a "Nightly" word), and
 * the document has to know which plate to paint BEFORE its first paint: a
 * value pushed over IPC, the way progress is, arrives after the page has
 * already painted the stable plate once, and that flash is the one thing the
 * variant must never do. A query string is read synchronously by the inline
 * script at the top of splash.html, ahead of the body.
 *
 * Stable sends no query at all, so its URL — and everything it paints — is
 * exactly what it was before nightlies had a plate of their own.
 */
export function splashQuery(buildChannel: AppUpdateTrack): Record<string, string> {
  return buildChannel === 'nightly' ? { channel: 'nightly' } : {}
}

/** `splash.html` under the dev server, with the channel query applied. */
export function splashDevUrl(rendererUrl: string, buildChannel: AppUpdateTrack): string {
  const url = new URL('splash.html', rendererUrl)
  for (const [key, value] of Object.entries(splashQuery(buildChannel))) url.searchParams.set(key, value)
  return url.toString()
}

// Never null: `new BrowserWindow` throws rather than returning nothing, and a
// nullable return would only buy a dead branch at the one call site.
//
// `buildChannel` is the channel this build was cut for (the update service's
// `buildChannel`), not the one it follows: the plate says what is launching.
export function createSplashWindow({ buildChannel }: { buildChannel: AppUpdateTrack }): BrowserWindow {
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
      // Its own one-channel preload, not the app's: the plate reads a progress
      // line and nothing else, and it starts at the same moment the main
      // window's renderer does. Sandboxed, since it needs nothing but Electron.
      preload: join(__dirname, '../preload/splash.js'),
      sandbox: true,
    },
  })
  splashWindow = win

  win.on('closed', () => {
    if (splashWindow === win) splashWindow = null
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    win.loadURL(splashDevUrl(rendererUrl, buildChannel))
  } else {
    win.loadFile(join(__dirname, '../renderer/splash.html'), { query: splashQuery(buildChannel) })
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
