import { execFile } from 'node:child_process'
import { BrowserWindow, net, session, shell, webContents, type Session, type WebContents } from 'electron'
import {
  BROWSER_PARTITION,
  type BrowserClearResult,
  type BrowserHostKey,
  type BrowserLoadError,
  type BrowserRegisterInput,
  type BrowserRegisterResult,
  type BrowserTabState,
  type LocalServer,
} from '../../shared/browser'
import { BROWSER_ZOOM_LEVELS, nextZoomLevel, type BrowserColorScheme } from '../../shared/browser-devices'
import { safeExternalUrl } from '../ipc/external-url'
import { parsePsTree, type ProcRow } from '../terminal-subtree-probe'

// The embedded browser's main-process half (browser-pane epic). The renderer
// owns the `<webview>` elements; this owns everything the renderer must not:
// the persistent partition and its permission policy, the listeners on each
// guest WebContents, the state pushed back to the hosting window, navigation
// commands, the popup policy, and local dev-server discovery. One instance
// per app; tabs are keyed by the renderer's pane tab id.

// The permissions a page may hold. Everything else — camera, microphone,
// MIDI, USB, local fonts, pointer lock — is denied without a prompt: this is
// a preview surface for the person's own dev server, not a general browser.
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'geolocation',
])

// A favicon past this is not a favicon. Mirrors the renderer's cap.
const MAX_FAVICON_BYTES = 8 * 1024
const FAVICON_TIMEOUT_MS = 3_000
// A dev server that has not answered a HEAD in this long is not one we list.
const SERVER_PROBE_TIMEOUT_MS = 1_200

// Chords the person expects to keep working while the guest has focus. The
// guest sees the keystroke first; these are re-dispatched to the host window
// (`browser:host-key`) so the app's own bindings — close tab, palette, pane
// toggle, zoom — act, and the page never sees them.
const HOST_FORWARDED_KEYS: ReadonlySet<string> = new Set(['w', 'k', 'b', 'p', '=', '+', '-', '0', 'j', 'e', 'g'])

export type TerminalRootInfo = {
  sessionId: string
  rootPid: number
  workspaceId: string | null
  terminalId: string | null
}

export type BrowserManagerDeps = {
  /** Every live pty and the workspace it belongs to (terminal-runtime's listTerminalRoots). */
  listTerminalRoots: () => TerminalRootInfo[]
  /** Whether a WebContents is one of this app's own windows — the only hosts a guest may register from. */
  isHostWindow: (host: WebContents) => boolean
  platform?: NodeJS.Platform
  runPs?: () => Promise<string | null>
  runLsofListening?: () => Promise<string | null>
  probeServer?: (url: string) => Promise<boolean>
}

type BrowserTab = {
  tabId: string
  workspaceId: string
  wc: WebContents
  host: WebContents
  state: BrowserTabState
  dispose: () => void
}

// Appearance emulation is a DevTools-protocol feature (there is no per-guest
// Electron API for prefers-color-scheme), so a tab whose scheme is not
// `system` holds an in-process debugger session. Chromium allows one client
// per target: while the person has DevTools open the session is released and
// the emulation lapses; it is re-applied when DevTools closes.
async function applyColorScheme(tab: BrowserTab): Promise<void> {
  const { wc } = tab
  if (wc.isDestroyed()) return
  const scheme = tab.state.colorScheme
  if (scheme === 'system') {
    if (wc.debugger.isAttached()) {
      try {
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] })
      } catch {
        // The target may be mid-navigation; the reset is best-effort.
      }
      wc.debugger.detach()
    }
    return
  }
  if (wc.isDevToolsOpened()) return
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    })
  } catch {
    // Another debugger owns the target (DevTools racing us); the scheme stays
    // recorded and is applied on the next re-attach.
  }
}

function execFileTextOrNull(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcn` prints field lines: `p<pid>`, `c<cmd>`,
 * then one `n<host:port>` per listening socket. Loopback and wildcard binds
 * are what a dev server offers; a bind to a specific LAN address is not
 * something the pane should reach for.
 */
export function parseListeningSockets(stdout: string): { pid: number; command: string; port: number }[] {
  const out: { pid: number; command: string; port: number }[] = []
  let pid = 0
  let command = ''
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      pid = Number(value)
      command = ''
    } else if (tag === 'c') {
      command = value
    } else if (tag === 'n' && pid > 0) {
      const match = value.match(/^(?:\*|127\.0\.0\.1|localhost|\[::1\]|\[::\]|0\.0\.0\.0):(\d+)$/)
      if (!match) continue
      const port = Number(match[1])
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      out.push({ pid, command, port })
    }
  }
  return out
}

/** Every pid under `rootPid` (excluding the root — the pty shell itself). */
export function descendantPids(rootPid: number, procs: readonly ProcRow[]): Set<number> {
  const childrenByParent = new Map<number, number[]>()
  for (const proc of procs) {
    const list = childrenByParent.get(proc.ppid)
    if (list) list.push(proc.pid)
    else childrenByParent.set(proc.ppid, [proc.pid])
  }
  const seen = new Set<number>()
  const stack = [...(childrenByParent.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    stack.push(...(childrenByParent.get(pid) ?? []))
  }
  return seen
}

function stripUserAgent(userAgent: string): string {
  // A dev server that sniffs `Electron/` serves a different page than the
  // one the person will ship; so does one that sees the app's own token.
  return userAgent
    .replace(/\s?Electron\/\S+/i, '')
    .replace(/\s?multicode\/\S+/i, '')
    .replace(/\s?sprintengine-studio\/\S+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

async function fetchFaviconDataUrl(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!type.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_FAVICON_BYTES) return null
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function probeLocalServer(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SERVER_PROBE_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, { method: 'GET', signal: controller.signal, redirect: 'manual' })
    // A redirect is a web server answering; so is any page. A 5xx from a dev
    // server mid-restart is still a web server — list it, the person can
    // reload. Only a refused or non-HTTP socket is left out.
    return response.status > 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function createBrowserManager(deps: BrowserManagerDeps) {
  const tabs = new Map<string, BrowserTab>()
  let browserSession: Session | null = null

  function ensureSession(): Session {
    if (browserSession) return browserSession
    const created = session.fromPartition(BROWSER_PARTITION)
    created.setUserAgent(stripUserAgent(created.getUserAgent()))
    created.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    created.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
    browserSession = created
    return created
  }

  function publish(tab: BrowserTab): void {
    if (tab.host.isDestroyed()) return
    tab.host.send('browser:state', tab.state)
  }

  function patch(tab: BrowserTab, next: Partial<BrowserTabState>): void {
    tab.state = { ...tab.state, ...next }
    publish(tab)
  }

  function readNavigation(wc: WebContents): Pick<BrowserTabState, 'url' | 'title' | 'canGoBack' | 'canGoForward'> {
    const history = wc.navigationHistory
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    }
  }

  function attach(tab: BrowserTab): () => void {
    const { wc } = tab
    const disposers: (() => void)[] = []
    const on = <K extends string>(event: K, handler: (...args: never[]) => void) => {
      // WebContents extends EventEmitter; the per-event typings are stricter
      // than a generic subscription needs.
      ;(wc as unknown as NodeJS.EventEmitter).on(event, handler as (...args: unknown[]) => void)
      disposers.push(() => {
        if (!wc.isDestroyed()) (wc as unknown as NodeJS.EventEmitter).off(event, handler as (...args: unknown[]) => void)
      })
    }

    on('did-start-loading', () => patch(tab, { loading: true }))
    on('did-stop-loading', () => patch(tab, { loading: false, ...readNavigation(wc) }))
    on('did-start-navigation', (details: { isMainFrame: boolean; isSameDocument: boolean; url: string }) => {
      if (!details.isMainFrame) return
      // A fresh document: the old title, favicon and error no longer describe
      // what is on screen. Same-document (hash/pushState) keeps them.
      if (details.isSameDocument) {
        patch(tab, { ...readNavigation(wc) })
        return
      }
      patch(tab, { url: details.url, title: '', faviconUrl: null, error: null, loading: true })
    })
    on('did-navigate', () => {
      patch(tab, { ...readNavigation(wc), error: null })
      // A new document loses the emulated media; re-assert the scheme.
      if (tab.state.colorScheme !== 'system') void applyColorScheme(tab)
    })
    on('devtools-opened', () => {
      // DevTools takes the debugger slot; let go of ours and say so.
      if (wc.debugger.isAttached()) wc.debugger.detach()
      patch(tab, { devToolsOpen: true })
    })
    on('devtools-closed', () => {
      patch(tab, { devToolsOpen: false })
      void applyColorScheme(tab)
    })
    on('zoom-changed', () => patch(tab, { zoomFactor: wc.getZoomFactor() }))
    on('did-navigate-in-page', () => patch(tab, { ...readNavigation(wc) }))
    on('page-title-updated', (_event: unknown, title: string) => patch(tab, { title }))
    on('page-favicon-updated', (_event: unknown, favicons: string[]) => {
      const [first] = favicons
      if (!first) return
      const at = wc.getURL()
      void fetchFaviconDataUrl(first).then((dataUrl) => {
        // Only if the page has not moved on meanwhile.
        if (!wc.isDestroyed() && tabs.get(tab.tabId) === tab && wc.getURL() === at) {
          patch(tab, { faviconUrl: dataUrl })
        }
      })
    })
    on('did-fail-load', (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
      // -3 is ERR_ABORTED: a navigation replaced by another, never an error the
      // person needs to see. Subframe failures are the page's business.
      if (!isMainFrame || code === -3) return
      const error: BrowserLoadError = { code, description, url }
      patch(tab, { loading: false, error, url })
    })
    on('render-process-gone', (_event: unknown, details: { reason: string }) => {
      patch(tab, {
        loading: false,
        error: { code: 0, description: `RENDERER_${details.reason.toUpperCase()}`, url: tab.state.url },
      })
    })
    on('before-input-event', (event: { preventDefault: () => void }, input: {
      type: string
      key: string
      meta: boolean
      control: boolean
      alt: boolean
      shift: boolean
    }) => {
      if (input.type !== 'keyDown') return
      const primary = process.platform === 'darwin' ? input.meta : input.control
      if (!primary) return
      const key = input.key.toLowerCase()
      if (key === 'r' && !input.shift && !input.alt) {
        event.preventDefault()
        wc.reload()
        return
      }
      if (key === 'l' && !input.shift && !input.alt) {
        event.preventDefault()
        if (!tab.host.isDestroyed()) tab.host.send('browser:focus-url', { tabId: tab.tabId })
        return
      }
      if (HOST_FORWARDED_KEYS.has(key)) {
        event.preventDefault()
        const hostKey: BrowserHostKey = {
          key: input.key,
          meta: input.meta,
          ctrl: input.control,
          alt: input.alt,
          shift: input.shift,
        }
        if (!tab.host.isDestroyed()) tab.host.send('browser:host-key', { tabId: tab.tabId, key: hostKey })
      }
    })

    // The popup policy (epic decision 2): a real `window.open` with the
    // new-window disposition and an http(s) URL — an OAuth flow — gets a
    // sandboxed popup that may not open windows of its own; everything else
    // (`target=_blank` links included) navigates the tab in place. Nothing
    // here reaches the system browser: that is the explicit action only.
    wc.setWindowOpenHandler((details) => {
      const isHttp = /^https?:\/\//i.test(details.url)
      if (isHttp && details.disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              partition: BROWSER_PARTITION,
            },
          },
        }
      }
      if (isHttp) void wc.loadURL(details.url)
      return { action: 'deny' }
    })
    on('did-create-window', (child: { webContents: WebContents }) => {
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    })
    on('destroyed', () => {
      tabs.delete(tab.tabId)
    })

    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  function requireTab(tabId: string): BrowserTab | null {
    const tab = tabs.get(tabId)
    if (!tab || tab.wc.isDestroyed()) {
      if (tab) tabs.delete(tabId)
      return null
    }
    return tab
  }

  return {
    getConfig() {
      ensureSession()
      return { partition: BROWSER_PARTITION }
    },

    /**
     * Adopt a guest the renderer attached. The host must be one of our windows
     * and the WebContents a `<webview>` guest of that host — a renderer cannot
     * hand main some other WebContents id and have it driven.
     */
    register(input: BrowserRegisterInput, host: WebContents): BrowserRegisterResult {
      if (!deps.isHostWindow(host)) return { ok: false, reason: 'foreign_host' }
      const wc = webContents.fromId(input.webContentsId)
      if (!wc || wc.isDestroyed()) return { ok: false, reason: 'unknown_webcontents' }
      if (wc.getType() !== 'webview') return { ok: false, reason: 'not_a_webview' }
      if (wc.hostWebContents?.id !== host.id) return { ok: false, reason: 'foreign_host' }
      const existing = tabs.get(input.tabId)
      if (existing) {
        if (existing.wc === wc) return { ok: true, state: existing.state }
        // The renderer remounted the guest (a crash recovery); the old one is
        // gone or going.
        existing.dispose()
        tabs.delete(input.tabId)
      }
      ensureSession()
      const tab: BrowserTab = {
        tabId: input.tabId,
        workspaceId: input.workspaceId,
        wc,
        host,
        state: {
          tabId: input.tabId,
          ...readNavigation(wc),
          faviconUrl: null,
          loading: wc.isLoading(),
          error: null,
          zoomFactor: 1,
          colorScheme: 'system',
          devToolsOpen: wc.isDevToolsOpened(),
        },
        dispose: () => {},
      }
      tab.dispose = attach(tab)
      // Guests inherit the embedder's zoom; a tab is its own document.
      wc.setZoomFactor(1)
      tabs.set(input.tabId, tab)
      return { ok: true, state: tab.state }
    },

    unregister(tabId: string): void {
      const tab = tabs.get(tabId)
      if (!tab) return
      tab.dispose()
      tabs.delete(tabId)
    },

    state(tabId: string): BrowserTabState | null {
      return requireTab(tabId)?.state ?? null
    },

    /** Tabs a workspace owns, for the agent tools (browser-tools child). */
    listTabs(workspaceId: string): BrowserTabState[] {
      return [...tabs.values()]
        .filter((tab) => tab.workspaceId === workspaceId && !tab.wc.isDestroyed())
        .map((tab) => tab.state)
    },

    webContentsOf(tabId: string): WebContents | null {
      return requireTab(tabId)?.wc ?? null
    },

    navigate(tabId: string, url: string): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      patch(tab, { error: null, loading: true, url })
      void tab.wc.loadURL(url).catch(() => {
        // did-fail-load reports the failure with its code; a rejected promise
        // for an aborted load carries nothing the person needs.
      })
      return true
    },

    back(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab || !tab.wc.navigationHistory.canGoBack()) return false
      tab.wc.navigationHistory.goBack()
      return true
    },

    forward(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab || !tab.wc.navigationHistory.canGoForward()) return false
      tab.wc.navigationHistory.goForward()
      return true
    },

    reload(tabId: string, ignoreCache = false): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      patch(tab, { error: null })
      if (ignoreCache) tab.wc.reloadIgnoringCache()
      else tab.wc.reload()
      return true
    },

    stop(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      tab.wc.stop()
      patch(tab, { loading: false })
      return true
    },

    setZoom(tabId: string, factor: number): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      const clamped = BROWSER_ZOOM_LEVELS.includes(factor) ? factor : 1
      tab.wc.setZoomFactor(clamped)
      patch(tab, { zoomFactor: clamped })
      return true
    },

    zoomStep(tabId: string, direction: 1 | -1 | 0): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      const next = direction === 0 ? 1 : nextZoomLevel(tab.wc.getZoomFactor(), direction)
      tab.wc.setZoomFactor(next)
      patch(tab, { zoomFactor: next })
      return true
    },

    setColorScheme(tabId: string, scheme: BrowserColorScheme): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      patch(tab, { colorScheme: scheme })
      void applyColorScheme(tab)
      return true
    },

    openDevTools(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      if (tab.wc.isDevToolsOpened()) {
        tab.wc.devToolsWebContents?.focus()
        return true
      }
      tab.wc.openDevTools({ mode: 'detach' })
      return true
    },

    /**
     * The page in its own window: a plain Chromium window on the same
     * partition, so a sign-in in one is a sign-in in both. Not a mirror of the
     * pane's guest — a second, independent view of the same URL.
     */
    openWindow(tabId: string): boolean {
      const tab = requireTab(tabId)
      if (!tab) return false
      const url = tab.state.url
      if (!/^https?:\/\//i.test(url)) return false
      const win = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 320,
        minHeight: 240,
        title: tab.state.title || url,
        webPreferences: {
          partition: BROWSER_PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      win.webContents.setWindowOpenHandler((details) => {
        if (/^https?:\/\//i.test(details.url)) void win.webContents.loadURL(details.url)
        return { action: 'deny' }
      })
      void win.loadURL(url)
      return true
    },

    async clearCookies(): Promise<BrowserClearResult> {
      try {
        await ensureSession().clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'],
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not clear cookies.' }
      }
    },

    async clearCache(): Promise<BrowserClearResult> {
      try {
        await ensureSession().clearCache()
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not clear the cache.' }
      }
    },

    /** The one route from the pane to the system browser: the explicit action. */
    openExternal(tabId: string): { ok: true } | { ok: false; message: string } {
      const tab = requireTab(tabId)
      if (!tab) return { ok: false, message: 'This browser tab is gone.' }
      const safe = safeExternalUrl(tab.state.url)
      if (!safe.ok) return safe
      void shell.openExternal(safe.url)
      return { ok: true }
    },

    /**
     * Dev servers this workspace's terminals are running: listening TCP ports
     * whose owning process descends from one of the workspace's ptys, kept
     * only if they answer HTTP. Polled by the browser tab's empty state, so
     * the cost (a `ps`, an `lsof`, a HEAD per port) is paid only while a
     * person is looking at it.
     */
    async listLocalServers(workspaceId: string): Promise<LocalServer[]> {
      const platform = deps.platform ?? process.platform
      if (platform !== 'darwin' && platform !== 'linux') return []
      const roots = deps.listTerminalRoots().filter((root) => root.workspaceId === workspaceId)
      if (roots.length === 0) return []
      const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=,args=']))
      const runLsof =
        deps.runLsofListening ?? (() => execFileTextOrNull('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']))
      const [psOut, lsofOut] = await Promise.all([runPs(), runLsof()])
      if (psOut === null || lsofOut === null) return []
      const procs = parsePsTree(psOut)
      const sockets = parseListeningSockets(lsofOut)
      const byPort = new Map<number, LocalServer>()
      for (const root of roots) {
        const owned = descendantPids(root.rootPid, procs)
        for (const socket of sockets) {
          if (!owned.has(socket.pid) || byPort.has(socket.port)) continue
          byPort.set(socket.port, {
            url: `http://localhost:${socket.port}/`,
            port: socket.port,
            pid: socket.pid,
            command: socket.command,
            sessionId: root.sessionId,
            terminalId: root.terminalId,
          })
        }
      }
      const probe = deps.probeServer ?? probeLocalServer
      const candidates = [...byPort.values()].sort((a, b) => a.port - b.port)
      const answers = await Promise.all(candidates.map((server) => probe(server.url)))
      return candidates.filter((_server, index) => answers[index])
    },

    /** For tests and shutdown. */
    disposeAll(): void {
      for (const tab of tabs.values()) tab.dispose()
      tabs.clear()
    },
  }
}

export type BrowserManager = ReturnType<typeof createBrowserManager>
