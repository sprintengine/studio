import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { WindowMaterial } from '../shared/electron-api'

// Main-readable mirror of the renderer's window-material preference
// (appSettings.appearance.windowMaterial). The renderer is the source of
// truth; unlike the color-scheme mirror this one IS persisted, because window
// vibrancy must be applied when the BrowserWindow is created — before the
// renderer has booted and pushed anything. A stale mirror self-heals on the
// renderer's first push.
//
// Glass is macOS-only: reads collapse to 'solid' elsewhere so no vibrancy
// path ever runs on Windows/Linux even with a copied-over profile.

const FILE_NAME = 'window-material.json'

let cached: WindowMaterial | undefined

function storePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

export function getWindowMaterial(): WindowMaterial {
  if (process.platform !== 'darwin') return 'solid'
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as { material?: unknown }
    cached = parsed.material === 'solid' ? 'solid' : 'glass'
  } catch {
    // No mirror yet (first launch): glass is the default material.
    cached = 'glass'
  }
  return cached
}

export function setWindowMaterial(material: WindowMaterial): void {
  cached = material
  try {
    writeFileSync(storePath(), JSON.stringify({ material }) + '\n', 'utf8')
  } catch {
    // Best-effort: a failed write only costs the next launch its first-paint
    // material; the renderer re-pushes on mount.
  }
}
