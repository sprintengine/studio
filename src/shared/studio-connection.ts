// How a Studio window reaches the Studio RPC: main makes a message channel
// for each connection, serves one end and hands the other to the window's
// preload, which keeps it out of the page and lends the page functions over
// it. The page holds a connection id and, for its hello, a ticket good once,
// for thirty seconds, on that one port: never a credential that outlives it.

/** Ask main for a connection: answered with its id and ticket; its port follows on `STUDIO_PORT_CHANNEL`. */
export const STUDIO_CONNECT_CHANNEL = 'studio:connect'
/** Main → preload: the window's end of a connection, `{ connectionId }` with the port transferred. */
export const STUDIO_PORT_CHANNEL = 'studio:port'

/** Which way the chat view reaches conversations in this window. */
export type StudioChatTransportMode = 'ipc' | 'studio'

/**
 * Set to `studio` to put the chat view on the Studio protocol, or `ipc` to
 * keep it on the conversation IPC. The IPC path is the default until the
 * protocol path has had its release beside it.
 */
export const STUDIO_CHAT_TRANSPORT_ENV = 'SPRINTENGINE_CHAT_TRANSPORT'

export function studioChatTransportMode(value: string | undefined): StudioChatTransportMode {
  return value?.trim().toLowerCase() === 'studio' ? 'studio' : 'ipc'
}

export type StudioConnectResult = { connectionId: string; ticket: string }
