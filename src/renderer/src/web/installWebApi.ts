import { createWebApi } from './createWebApi'
import { refusedChannels } from './unsupported'

// Installed before anything else in a web tab runs (main.tsx), in the place a
// desktop window's preload puts its own. Nothing in the renderer reads
// `window.api` while its modules load, only once React mounts, so this runs
// in time.

const api = createWebApi()
;(window as unknown as { api: typeof api }).api = api

// The missing-member report, for a person or a test driving the tab.
;(window as unknown as { __studioWebRefusals?: () => string[] }).__studioWebRefusals = refusedChannels

// A file dropped anywhere but a drop target would navigate the tab away from
// the app; the desktop's main process stops that with `will-navigate`.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => {
    if (!event.defaultPrevented) event.preventDefault()
  })
}

// Once the app has loaded, an owner's tab offers Studio's agents the canvas,
// drawn by the same editor the desktop uses (phase 9 spec, 3.8).
// Loaded then, not with this module: the editor and the canvas service are no
// part of what the tab needs before it first paints.
window.addEventListener(
  'load',
  () => {
    void import('./canvas/startWebCanvas').then((module) => module.startWebCanvas())
    // And says when the server has moved on to a newer bundle than this tab's.
    void import('./webBuildWatch').then((module) => module.startWebBuildWatch())
  },
  { once: true },
)
