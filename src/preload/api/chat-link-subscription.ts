import {
  CHAT_LINK_ACK_CHANNEL,
  CHAT_LINK_OPEN_CHANNEL,
  CHAT_LINK_READY_CHANNEL,
  CHAT_LINK_UNREADY_CHANNEL,
  type ChatLink,
} from '../../shared/deep-link'

// A window's end of the chat-link handshake (main/chat-link-router.ts). Kept
// apart from the preload's `windowApi` so a test can drive it with a stand-in
// for `ipcRenderer`.

type Listener = (event: unknown, ...args: unknown[]) => void

/** The part of the window's IPC the subscription uses. */
export type ChatLinkIpcPort = {
  on(channel: string, listener: Listener): unknown
  removeListener(channel: string, listener: Listener): unknown
  send(channel: string, ...args: unknown[]): void
}

export function subscribeToChatLinks(ipc: ChatLinkIpcPort, onLink: (link: ChatLink) => void): () => void {
  // Main sends a link again when it has not heard that it was opened, and a
  // second listener in the same page saying it is listening is one of the
  // ways that happens. The chat is opened once per generation all the same.
  const opened = new Set<number>()
  const handler: Listener = (_event, link, generation) => {
    if (typeof generation !== 'number' || opened.has(generation)) return
    onLink(link as ChatLink)
    // Only once the chat has been opened: a callback that throws leaves the
    // link unanswered, and main sends it again when this page goes.
    opened.add(generation)
    ipc.send(CHAT_LINK_ACK_CHANNEL, generation)
  }
  // The listener first, then the word to main, so a link main was holding
  // cannot arrive before anyone hears it.
  ipc.on(CHAT_LINK_OPEN_CHANNEL, handler)
  ipc.send(CHAT_LINK_READY_CHANNEL)
  return () => {
    ipc.removeListener(CHAT_LINK_OPEN_CHANNEL, handler)
    ipc.send(CHAT_LINK_UNREADY_CHANNEL)
  }
}
