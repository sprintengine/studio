import { pathToFileURL } from 'node:url'

// The app's own windows load the renderer with the preload's bridge to the
// machine attached — terminals, files, git. That bridge is exposed to whatever
// document the window is showing, so the window must only ever show the app.
// Two ways out existed: a `window.open` (or `target="_blank"` link) whose URL
// was handed to the OS whatever its scheme, and a navigation of the window
// itself, which nothing stopped. Both are closed here, for every such window.

/** The subset of `WebContents` the guard touches, so it can be tested without Electron. */
export type GuardedContents = {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown
}

// mailto stays: a markdown message's mail link opens through `window.open`, and
// the mail app is not a place a link can do harm.
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** The link a `window.open` may hand to the OS, or null to drop it. */
export function externalLinkForWindowOpen(url: string): string | null {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol) ? url : null
  } catch {
    return null
  }
}

/**
 * The document the app's windows load: the dev server in development, the
 * bundled `index.html` otherwise. Query strings and fragments are the app's own
 * (a window id, a view) and do not change which document it is.
 */
export function appDocumentUrl(rendererDevUrl: string | undefined, indexHtmlPath: string): URL {
  return rendererDevUrl ? new URL(rendererDevUrl) : pathToFileURL(indexHtmlPath)
}

/** Whether a navigation stays on the app's own document. */
export function isAppDocument(target: string, app: URL): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (app.protocol === 'file:') return url.protocol === 'file:' && url.pathname === app.pathname
  return url.origin === app.origin
}

export function guardPrivilegedWindow(
  contents: GuardedContents,
  app: URL,
  openExternal: (url: string) => Promise<void> | void,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    const external = externalLinkForWindowOpen(url)
    if (external) void openExternal(external)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isAppDocument(url, app)) event.preventDefault()
  })
}
