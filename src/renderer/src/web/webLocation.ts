// Where this tab's server is, as the page was served from it. Relative to the
// page so a server behind a proxy under a path prefix works unchanged (the
// build uses `base: './'`).

export function webSocketUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.hash = ''
  url.search = ''
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

export function webPageUrl(path: string): string {
  return new URL(path, window.location.href).toString()
}

/**
 * This tab's workspace window (phase 9 spec, 3.5, as amended). A tab opened
 * on the app is the server's primary window, as the desktop's first window
 * is, so every plain tab shows the same workspaces; a tab opened by "New
 * window" carries a window id of its own in its address (`?windowId=`), which
 * a reload keeps. The renderer reads the same query for its own window id, so
 * the two always agree, and the server's workspace sync holds each tab to the
 * window it says it is.
 */
export function webWindowId(): string {
  try {
    const asked = new URL(window.location.href).searchParams.get('windowId')?.trim()
    if (asked && /^[\w-]{1,64}$/u.test(asked)) return asked
  } catch {
    // An address the URL parser refuses is the primary window's.
  }
  return 'primary'
}

/** The browser was removed in Studio, or its session ran out: back to pairing. */
export function returnToPairing(): void {
  window.location.replace(webPageUrl('./pair'))
}
