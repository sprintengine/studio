import type { ChatLink } from '../shared/deep-link'

// Where a `sprintengine://chat/…` link lands (shared/deep-link.ts has the
// grammar). Main picks the window and brings it forward; the window's renderer
// opens the chat, or says it is not on this machine, because its store is
// where the chat is or is not (workspaceManager's `chatLinkOpener`).
//
// A link can arrive before there is anyone to hand it to: on macOS a link that
// launches the app comes as `open-url` before `ready`, and on every platform
// the window it was meant for may still be loading. So the link is held until a
// window says it is listening, and only the latest one is held — two links
// clicked during a launch end on the second, as two clicks in a running app
// would.
//
// The window is the one already holding the chat (a chat moved to a window of
// its own opens there), else the focused one, else the primary, else any. With
// none open — the app running in the background — one is opened, and the link
// waits for it.
//
// Electron-free, so a test drives it with stand-ins.

export type ChatLinkWindow = {
  isDestroyed(): boolean
  isFocused(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  restore(): void
  focus(): void
}

export type ChatLinkRouterDeps<W extends ChatLinkWindow> = {
  /** The open workspace windows: never an aux window or the hidden canvas worker. */
  windows: () => W[]
  /** The workspace-window id a window was opened with. */
  windowIdOf: (window: W) => string
  primaryWindowId: () => string
  /** The window the registry files this chat under; null when it files it nowhere. */
  holderOf: (chatId: string) => string | null
  /** Whether windows can be made yet: before `ready` the boot makes the first one. */
  canOpenWindow: () => boolean
  /** Open a window, as the tray's Open does. Asked at most once per link. */
  openWindow: () => void
  /** Hand the link to a window that is listening. */
  send: (window: W, link: ChatLink) => void
}

export type ChatLinkRouter<W extends ChatLinkWindow> = {
  open(link: ChatLink): void
  /** A window's renderer is listening; anything held for it goes now. */
  windowReady(window: W): void
  /** A window stopped listening: it reloaded, closed or crashed. */
  windowGone(window: W): void
}

export function createChatLinkRouter<W extends ChatLinkWindow>(deps: ChatLinkRouterDeps<W>): ChatLinkRouter<W> {
  let pending: ChatLink | null = null
  // Whether a window was already asked for this link: the flushes that follow
  // (a window going away, say) must not open one each.
  let windowAsked = false
  const listening = new Set<W>()

  function target(link: ChatLink, windows: W[]): W | null {
    const holder = deps.holderOf(link.chatId)
    const byId = (id: string | null) => (id ? (windows.find((win) => deps.windowIdOf(win) === id) ?? null) : null)
    return byId(holder) ?? windows.find((win) => win.isFocused()) ?? byId(deps.primaryWindowId()) ?? windows[0] ?? null
  }

  function flush(): void {
    const link = pending
    if (!link) return
    const windows = deps.windows().filter((win) => !win.isDestroyed())
    const win = target(link, windows)
    if (!win) {
      if (!windowAsked && deps.canOpenWindow()) {
        windowAsked = true
        deps.openWindow()
      }
      return
    }
    // The chosen window is still loading: it takes the link when it says it is
    // listening, and is raised then rather than shown half-built.
    if (!listening.has(win)) return
    pending = null
    // A window held hidden is mid-boot (the splash is up) or mid-update; the
    // boot reveal shows it, and showing it here would put both on screen.
    if (win.isVisible()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    deps.send(win, link)
  }

  return {
    open(link) {
      pending = link
      windowAsked = false
      flush()
    },
    windowReady(win) {
      listening.add(win)
      flush()
    },
    windowGone(win) {
      listening.delete(win)
      flush()
    },
  }
}
