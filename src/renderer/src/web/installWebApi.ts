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
