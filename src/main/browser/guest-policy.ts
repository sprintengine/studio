import { resolve } from 'node:path'
import { BROWSER_PARTITION, isLoadableBrowserUrl } from '../../shared/browser'

// The `will-attach-webview` policy, as a pure function so it can be tested:
// every guest a workspace window attaches is the embedded browser and nothing
// else — our partition, http(s) only, sandboxed, no Node in any frame. Whatever
// the renderer wrote on the tag is overruled here, so a compromised renderer
// cannot mint a privileged guest.

export type GuestAttachParams = { partition?: string; src?: string }
export type GuestWebPreferences = Record<string, unknown> & { preload?: string; contextIsolation?: boolean }

/**
 * Mutates `webPreferences` into the only shape a guest may have and returns
 * whether the attach may proceed at all.
 */
export function applyGuestWebPreferences(
  webPreferences: GuestWebPreferences,
  params: GuestAttachParams,
  pickerPreloadPath: string | null,
): boolean {
  if (params.partition !== BROWSER_PARTITION) return false
  if (typeof params.src === 'string' && params.src && !isLoadableBrowserUrl(params.src)) return false
  // The only preload a guest may carry is the element picker we ship; any
  // other path is dropped. The picker reads the page's React fiber, which an
  // isolated world cannot see, so context isolation is off exactly when that
  // preload is present — and the preload is sandboxed either way.
  const requested = webPreferences.preload
  if (pickerPreloadPath && requested && resolve(requested) === resolve(pickerPreloadPath)) {
    webPreferences.preload = pickerPreloadPath
    webPreferences.contextIsolation = false
  } else {
    delete webPreferences.preload
    webPreferences.contextIsolation = true
  }
  webPreferences.sandbox = true
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  return true
}
