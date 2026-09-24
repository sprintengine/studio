import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { WindowMaterial } from '../shared/electron-api'

// Main-readable mirror of the renderer's window-material preference
// (appSettings.appearance.windowMaterial). The renderer is the source of
// truth; unlike the color-scheme mirror this one IS persisted, because window
// vibrancy and the opaque background colour must be applied when the
// BrowserWindow is created — before the renderer has booted and pushed
// anything. A stale mirror self-heals on the renderer's first push.
//
// Glass is macOS-only: a 'glass' read anywhere else resolves to 'tinted', the
// opaque material that takes glass's place as the default where there is no
// vibrancy, so no vibrancy path ever runs on Windows/Linux even with a
// copied-over profile.
//
// Beside the material the mirror keeps the theme's opaque canvas colour, which
// an opaque window (tinted or solid) paints before its renderer has drawn
// anything. Without it a light theme opens on a fixed dark ground and flashes
// as the renderer takes over.

const FILE_NAME = 'window-material.json'

// The dark ink the app has always opened on; the fallback until the renderer
// has pushed its theme's own canvas once.
const DEFAULT_WINDOW_CANVAS_COLOR = '#09090b'

const HEX_COLOR = /^#[0-9a-f]{6}$/i

type Mirror = { material: WindowMaterial; canvasColor: string }

let cached: Mirror | undefined

function storePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

// The material a persisted (or pushed) value means on this platform. Missing
// or unknown takes the platform default: glass where the OS has vibrancy,
// tinted where it does not.
export function resolveWindowMaterial(value: unknown, platform: NodeJS.Platform = process.platform): WindowMaterial {
  if (value === 'solid' || value === 'tinted') return value
  return platform === 'darwin' ? 'glass' : 'tinted'
}

export function normalizeWindowCanvasColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : undefined
}

function readMirror(): Mirror {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as { material?: unknown; canvasColor?: unknown }
    cached = {
      material: resolveWindowMaterial(parsed.material),
      canvasColor: normalizeWindowCanvasColor(parsed.canvasColor) ?? DEFAULT_WINDOW_CANVAS_COLOR,
    }
  } catch {
    // No mirror yet (first launch): the platform's default material.
    cached = { material: resolveWindowMaterial(undefined), canvasColor: DEFAULT_WINDOW_CANVAS_COLOR }
  }
  return cached
}

export function getWindowMaterial(): WindowMaterial {
  return readMirror().material
}

export function getWindowCanvasColor(): string {
  return readMirror().canvasColor
}

export function setWindowMaterial(material: WindowMaterial, canvasColor?: string): void {
  // A push without a colour (glass has none to send) keeps the last one, so a
  // later switch back to an opaque material still opens on the theme's ground.
  cached = { material, canvasColor: canvasColor ?? readMirror().canvasColor }
  try {
    writeFileSync(storePath(), JSON.stringify(cached) + '\n', 'utf8')
  } catch {
    // Best-effort: a failed write only costs the next launch its first-paint
    // material; the renderer re-pushes on mount.
  }
}
