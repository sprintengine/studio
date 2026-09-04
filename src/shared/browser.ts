// The embedded browser's contract between main, preload and the renderer
// (browser-pane epic). Node-free: shared by all three.

// One persistent partition for the whole machine (epic decision 2): cookies
// and storage are shared across workspaces; Clear cookies / Clear cache act on
// it. `will-attach-webview` refuses any other partition.
export const BROWSER_PARTITION = 'persist:sprintengine-browser'

// The guest's webpreferences string. Whitespace-free `key=value` pairs — a
// space in the attribute silently breaks parsing. `sandbox=true` is what keeps
// a preload's Node access from ever reaching the page; `nodeIntegration`
// stays off. Main re-asserts both in `will-attach-webview` whatever the
// renderer wrote.
export const BROWSER_WEBPREFERENCES = 'contextIsolation=true,sandbox=true,nodeIntegration=false'

export type BrowserLoadError = {
  code: number
  description: string
  url: string
}

export type BrowserTabState = {
  tabId: string
  url: string
  title: string
  faviconUrl: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: BrowserLoadError | null
  zoomFactor: number
  colorScheme: 'system' | 'light' | 'dark'
  devToolsOpen: boolean
}

export type BrowserClearResult = { ok: true } | { ok: false; message: string }

export type BrowserRegisterInput = {
  tabId: string
  workspaceId: string
  webContentsId: number
}

export type BrowserRegisterResult =
  | { ok: true; state: BrowserTabState }
  | { ok: false; reason: 'not_a_webview' | 'foreign_host' | 'unknown_webcontents' | 'already_registered' }

export type BrowserConfig = {
  partition: string
  webPreferences: string
}

export type LocalServer = {
  url: string
  port: number
  pid: number
  /** The listening process's command name (`node`, `python3`). */
  command: string
  /** The pane/terminal session the server runs under, when it is one of ours. */
  sessionId: string
  terminalId: string | null
}

export type BrowserHostKey = {
  key: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export const BROWSER_MAX_URL_LENGTH = 2048
export const BROWSER_MAX_RECENT_URLS = 8

/**
 * What a person types in the address field, as a URL the guest can load:
 * `localhost:5173` gains `http://`, a bare host with a dot gains `https://`,
 * whitespace is trimmed. Anything that is not http(s) (or about:blank) is
 * refused — `file:`, `javascript:` and custom protocols never reach the guest
 * from the address field.
 */
export function normalizeBrowserUrlInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > BROWSER_MAX_URL_LENGTH) return null
  if (trimmed === 'about:blank') return trimmed
  // A scheme is only a scheme when `//` follows it: `localhost:5173` is a
  // host and a port, not a `localhost:` protocol.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const candidate = hasScheme ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  return parsed.toString()
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

/** The tab strip's label for a page with no title yet: the host, or the kind. */
export function browserTabLabel(url: string | undefined, title: string | undefined): string {
  if (title?.trim()) return title.trim()
  if (!url || url === 'about:blank') return 'Browser'
  try {
    const parsed = new URL(url)
    return parsed.host || 'Browser'
  } catch {
    return 'Browser'
  }
}
