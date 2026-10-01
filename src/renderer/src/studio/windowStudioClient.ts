import {
  connect,
  type StudioClient,
  type StudioTransport,
  type StudioTransportFactory,
} from '../../../../packages/agent-sdk/src/index'
import type { ElectronApi } from '../../../shared/electron-api'

// This window's client of the Studio RPC: the same `@sprintengine/agent-sdk`
// client a script or a web page uses, over the connection main brokers for the
// window. The preload keeps the port; the page holds a connection id and,
// for one hello, the ticket main minted for it. Each reconnect asks main for a
// fresh connection and ticket, and the client resumes its streams from their
// cursors and resends what was unanswered.
//
// When the server moves out of main, main brokers the same channel to it and
// nothing here changes.

type PortApi = Pick<ElectronApi, 'studioConnect' | 'studioPortSend' | 'studioPortListen' | 'studioPortClose'>

/** A transport over one window connection at a time, asking main for a new one on each call. */
export function windowPortTransport(api: PortApi): StudioTransportFactory {
  return async () => {
    const { connectionId, ticket } = await api.studioConnect()
    const messageListeners: Array<(frame: string) => void> = []
    const closeListeners: Array<(error?: Error) => void> = []
    let closed = false
    const end = () => {
      if (closed) return
      closed = true
      // Heard after the current frame, as a socket's close is: the client
      // reads a close inside its own `close()` call no differently.
      queueMicrotask(() => {
        for (const listener of closeListeners.splice(0)) listener()
      })
    }
    api.studioPortListen(
      connectionId,
      (frame) => {
        if (!closed) for (const listener of messageListeners) listener(frame)
      },
      end,
    )
    const transport: StudioTransport = {
      credential: { token: ticket },
      send: (frame) => {
        if (!closed) api.studioPortSend(connectionId, frame)
      },
      close: () => {
        if (closed) return
        api.studioPortClose(connectionId)
        end()
      },
      onMessage: (listener) => void messageListeners.push(listener),
      onClose: (listener) => void closeListeners.push(listener),
    }
    return transport
  }
}

const clients = new WeakMap<object, Promise<StudioClient>>()
// The client each window's promise settled to, so one that has closed is
// known at once rather than a turn later.
const settled = new WeakMap<object, StudioClient>()
// The Studio each window belongs to, by its environment id: a window's later
// clients refuse any other, so nothing the window holds (a stream's cursor, a
// command's id) is ever offered to a different Studio.
const environments = new WeakMap<object, string>()

/**
 * The window's client, connected on first use and kept. A first connection
 * that fails is forgotten, so the next use tries again; once connected, the
 * client reconnects by itself. Asking for it again is a retry: a client parked
 * by a refused ticket or by being offline tries to connect now, and one that
 * closed for good (a version outside the window, another Studio) is replaced.
 */
export function windowStudioClient(api: PortApi = window.api): Promise<StudioClient> {
  const known = clients.get(api)
  const client = settled.get(api)
  if (known && client?.state !== 'closed') {
    if (client?.state === 'parked') client.wake()
    return known
  }
  settled.delete(api)
  const bound = environments.get(api)
  const connecting = connect({
    transport: windowPortTransport(api),
    client: { name: 'Studio window' },
    // A window and the Studio it belongs to come and go together; a short
    // ceiling brings a window back quickly after a restart of the server.
    reconnect: { initialDelayMs: 100, maxDelayMs: 5_000 },
    ...(bound === undefined ? {} : { environmentId: bound }),
  })
  clients.set(api, connecting)
  const forget = () => {
    if (clients.get(api) === connecting) clients.delete(api)
  }
  void connecting.then((connected) => {
    if (clients.get(api) === connecting) settled.set(api, connected)
    if (!environments.has(api)) environments.set(api, connected.welcome.environment.id)
    connected.closed.then(forget, forget)
  }, forget)
  return connecting
}
