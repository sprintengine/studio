// The embedded browser's contract between main, preload and the renderer
// (browser-pane epic). Node-free: shared by all three.

// One persistent partition for the whole machine (epic decision 2): cookies
// and storage are shared across workspaces; Clear cookies / Clear cache act on
// it. `will-attach-webview` refuses any other partition.
export const BROWSER_PARTITION = 'persist:sprintengine-browser'

// The guest's webpreferences string. Whitespace-free `key=value` pairs — a
// space in the attribute silently breaks parsing. `sandbox=true` is what keeps
// the preload's Node access from ever reaching the page; `nodeIntegration`
// stays off. `contextIsolation=false` because the element picker reads the
// page's React fiber off DOM nodes, and an isolated world cannot see the main
// world's expandos — a deliberate trade: the picker is the pane's reason to
// exist, and `sandbox=true` is what actually contains the guest. The preload keeps
// everything in closures and puts nothing on `window`. Main re-asserts all
// three in `will-attach-webview` whatever the renderer wrote.
export const BROWSER_WEBPREFERENCES = 'contextIsolation=false,sandbox=true,nodeIntegration=false'

// Guest preload ↔ host renderer channels (webview `send` / `sendToHost`).
export const BROWSER_PICK_START_CHANNEL = 'browser:pick:start'
export const BROWSER_PICK_STOP_CHANNEL = 'browser:pick:stop'
export const BROWSER_PICKED_CHANNEL = 'browser:picked'
export const BROWSER_PICK_CANCELLED_CHANNEL = 'browser:pick:cancelled'

// Colours the picker overlay draws with, resolved from the app's tokens by
// the host and sent with the start message so the overlay matches the theme.
export type BrowserPickTheme = {
  accent: string
  accentSoft: string
  chipBackground: string
  chipBorder: string
  chipText: string
}

export type BrowserPickedElement = {
  url: string
  title: string
  selector: string
  tagName: string
  text: string
  outerHtml: string
  /** Viewport (CSS px) rect of the element, for the crop. */
  rect: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
  styles: Record<string, string>
  /** React owner chain, nearest first, when the page exposes its fiber. */
  components: string[]
  /** `file:line:col` from React's debug source, when the page ships it. */
  source: string | null
}

export type BrowserScreenshotResult =
  | { ok: true; path: string; width: number; height: number }
  | { ok: false; message: string }

export const BROWSER_MAX_OUTER_HTML = 4000
export const BROWSER_PICK_CROP_PADDING = 20

export type BrowserLoadError = {
  code: number
  description: string
  url: string
}

export type BrowserTabState = {
  tabId: string
  url: string
  /** The last committed main-frame document, without in-page (hash/pushState) moves. */
  documentUrl: string
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

export type BrowserCaptureInput = {
  tabId: string
  /** The workspace folder the PNG is written under (`.multi-code/browser/`). */
  workspaceRoot: string
  /** Guest-viewport rect to crop to; the whole page when absent. */
  rect?: { x: number; y: number; width: number; height: number }
  /** File name stem: `screenshot` or `element`. */
  kind: 'screenshot' | 'element'
}

/** Whether a URL may be loaded in the guest at all: http(s) or a blank tab. */
export function isLoadableBrowserUrl(url: string): boolean {
  return url === 'about:blank' || /^https?:\/\//i.test(url)
}

export type BrowserConfig = {
  partition: string
  /** file:// URL of the guest preload (the element picker); null when it is not built. */
  preloadUrl: string | null
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
