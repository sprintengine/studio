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
// Sending is not the end of it. The page can die between main sending a link
// and its renderer opening the chat (a crash, a reload, the window closing),
// and the link would be lost with it. So each link carries a generation, and
// main keeps it until the window says it opened that generation. If the window
// goes first, or comes back with a new page that never said so, the link goes
// out again: to that window once it is listening, else to the next choice.
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
  /** Hand the link to a window that is listening, with the generation it acknowledges. */
  send: (window: W, link: ChatLink, generation: number) => void
}

export type ChatLinkRouter<W extends ChatLinkWindow> = {
  open(link: ChatLink): void
  /** A window's renderer is listening; anything held for it goes now. */
  windowReady(window: W): void
  /** A window stopped listening: it reloaded, closed or crashed. */
  windowGone(window: W): void
  /** A window opened the link of this generation, so it need not be sent again. */
  ack(window: W, generation: number): void
}

export function createChatLinkRouter<W extends ChatLinkWindow>(deps: ChatLinkRouterDeps<W>): ChatLinkRouter<W> {
  // The latest link, until a window acknowledges it. `sentTo` is the window it
  // went to and is waiting on; null while it still has to be sent.
  let held: { link: ChatLink; generation: number; sentTo: W | null } | null = null
  let generation = 0
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
    if (!held || held.sentTo) return
    const windows = deps.windows().filter((win) => !win.isDestroyed())
    const win = target(held.link, windows)
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
    held.sentTo = win
    // A window held hidden is mid-boot (the splash is up) or mid-update; the
    // boot reveal shows it, and showing it here would put both on screen.
    if (win.isVisible()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    deps.send(win, held.link, held.generation)
  }

  // The window a link went to stopped, or started again, without opening it:
  // the link is due again.
  function unsend(win: W): void {
    if (held?.sentTo === win) held.sentTo = null
  }

  return {
    open(link) {
      // A newer link replaces one still waiting for its window to answer, as
      // it replaces one still waiting to be sent: only the latest is held.
      generation += 1
      held = { link, generation, sentTo: null }
      windowAsked = false
      flush()
    },
    windowReady(win) {
      // A window saying it is listening while a link it was sent is still
      // unanswered has, as a rule, a new page that never saw it. A page that
      // did see it drops a generation it already opened, so sending it again
      // is safe either way.
      unsend(win)
      listening.add(win)
      flush()
    },
    windowGone(win) {
      unsend(win)
      listening.delete(win)
      flush()
    },
    ack(win, acked) {
      if (held?.sentTo === win && held.generation === acked) held = null
    },
  }
}
