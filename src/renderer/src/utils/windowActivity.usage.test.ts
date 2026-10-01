import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'vitest'

// Work the renderer pauses while nobody can see the window pauses on the
// window-activity signal (`isWindowVisible` / `onWindowVisibilityChange`), not
// on the Page Visibility API alone: on macOS a minimized or covered window
// keeps reporting `document.hidden === false`, and only main's
// `window:hidden-changed` says otherwise. A poll gated on `document.hidden`
// therefore keeps running in a minimized window. This keeps a new one from
// appearing.

const RENDERER_ROOT = join(__dirname, '..')

// Reads of the page's own visibility that are not a pause, each with its reason.
const ALLOWED = new Map<string, string>([
  // The source of the window-activity signal itself.
  ['utils/windowActivity.ts', 'folds the page signal together with main’s'],
  // Flushes a pending settings write when the page is going away; an extra
  // flush on minimize would be harmless, and this is persistence, not paused work.
  ['store/workspaceStore.ts', 'flush-on-hide persistence'],
  // Refreshes the plugin catalog when the person comes back, next to a focus
  // listener that already covers the minimize case.
  ['store/slices/pluginsSlice.ts', 'refresh on return, paired with focus'],
])

const PAGE_VISIBILITY = /\bdocument\.hidden\b|\bdocument\.visibilityState\b|['"]visibilitychange['"]/

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* sources(full)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full
  }
}

test('renderer work pauses on the window-activity signal, not on document.hidden', () => {
  const offenders: string[] = []
  for (const file of sources(RENDERER_ROOT)) {
    const path = relative(RENDERER_ROOT, file).split(sep).join('/')
    if (ALLOWED.has(path)) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
        if (PAGE_VISIBILITY.test(line)) offenders.push(`${path}:${index + 1}: ${code}`)
      })
  }
  assert.deepEqual(
    offenders,
    [],
    'use isWindowVisible / onWindowVisibilityChange from utils/windowActivity instead of the Page Visibility API',
  )
})
