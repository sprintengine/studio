import {
  CHAT_LINK_ACK_CHANNEL,
  CHAT_LINK_READY_CHANNEL,
  CHAT_LINK_UNREADY_CHANNEL,
  chatLinkFromArgv,
  type ChatLink,
} from '../shared/deep-link'
import type { ChatLinkRouter, ChatLinkWindow } from './chat-link-router'

// How main hears a window's side of a chat link (the preload's
// chat-link-subscription.ts), and what a second launch of the app does with
// one. Electron-free, so a test drives both with stand-ins for `ipcMain`, a
// window and its web contents.

/** The page events that mean a window's listener is gone with its page. */
export type ChatLinkContents = {
  on(event: 'did-navigate' | 'render-process-gone', listener: () => void): unknown
}

export type ChatLinkHostWindow = ChatLinkWindow & {
  once(event: 'closed', listener: () => void): unknown
}

export type ChatLinkIpcMain<C> = {
  on(channel: string, listener: (event: { sender: C }, ...args: unknown[]) => void): unknown
}

export type ChatLinkIpcDeps<C extends ChatLinkContents, W extends ChatLinkHostWindow> = {
  ipcMain: ChatLinkIpcMain<C>
  router: Pick<ChatLinkRouter<W>, 'windowReady' | 'windowGone' | 'ack'>
  /** The window a page belongs to; null when it belongs to none. */
  windowOf: (contents: C) => W | null
  /** Whether a page is a workspace window's: no aux window, pop-out or canvas worker takes a link. */
  isWorkspaceWindow: (contents: C) => boolean
}

export function registerChatLinkIpc<C extends ChatLinkContents, W extends ChatLinkHostWindow>({
  ipcMain,
  router,
  windowOf,
  isWorkspaceWindow,
}: ChatLinkIpcDeps<C, W>): void {
  const workspaceWindowOf = (contents: C): W | null => (isWorkspaceWindow(contents) ? windowOf(contents) : null)
  // A window is listening once its registry has loaded, and stops when its page
  // goes: a reload says so again from the new page, a crash or a close does not.
  // The watchers go on once per page, however often it says it is listening.
  const watched = new WeakSet<C>()
  ipcMain.on(CHAT_LINK_READY_CHANNEL, (event) => {
    const contents = event.sender
    const win = workspaceWindowOf(contents)
    if (!win) return
    if (!watched.has(contents)) {
      watched.add(contents)
      const gone = () => router.windowGone(win)
      contents.on('did-navigate', gone)
      contents.on('render-process-gone', gone)
      win.once('closed', gone)
    }
    router.windowReady(win)
  })
  ipcMain.on(CHAT_LINK_UNREADY_CHANNEL, (event) => {
    const win = workspaceWindowOf(event.sender)
    if (win) router.windowGone(win)
  })
  ipcMain.on(CHAT_LINK_ACK_CHANNEL, (event, generation) => {
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation)) return
    const win = workspaceWindowOf(event.sender)
    if (win) router.ack(win, generation)
  })
}

export type SecondLaunchDeps = {
  /** Hand a chat link to the router, which raises the window it opens in, or opens one. */
  openChatLink: (link: ChatLink) => void
  /** Bring a window forward, or open one, as the tray's Open does. */
  openWindow: () => void
}

/**
 * A second launch of the app, as the running one hears it. With a chat link
 * among its arguments only the router raises a window, the one the chat opens
 * in: raising the first window as well put two windows in front of the person,
 * and the wrong one could end up on top.
 */
export function routeSecondLaunch(argv: readonly string[], deps: SecondLaunchDeps): void {
  const link = chatLinkFromArgv(argv)
  if (link) deps.openChatLink(link)
  else deps.openWindow()
}
