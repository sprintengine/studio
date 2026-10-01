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
// The Studio each window belongs to, by its environment id: a window's later
// clients refuse any other, so nothing the window holds (a stream's cursor, a
// command's id) is ever offered to a different Studio.
const environments = new WeakMap<object, string>()

/**
 * The window's client, connected on first use and kept. A first connection
 * that fails is forgotten, so the next use tries again; once connected, the
 * client reconnects by itself.
 */
export function windowStudioClient(api: PortApi = window.api): Promise<StudioClient> {
  const known = clients.get(api)
  if (known) return known
  const bound = environments.get(api)
  const connecting = connect({
    transport: windowPortTransport(api),
    client: { name: 'Studio window' },
    // A window and the Studio it belongs to come and go together; a short
    // ceiling brings a window back quickly after a restart of the server.
    reconnect: { initialDelayMs: 100, maxDelayMs: 5_000 },
    ...(bound === undefined ? {} : { environmentId: bound }),
  })
  void connecting.then(
    (client) => {
      if (!environments.has(api)) environments.set(api, client.welcome.environment.id)
    },
    () => undefined,
  )
  clients.set(api, connecting)
  const forget = () => {
    if (clients.get(api) === connecting) clients.delete(api)
  }
  // A client that closed for good (a refused ticket, a version outside the
  // window) is forgotten too, so the next use starts a new one.
  connecting.then((client) => client.closed.then(forget, forget), forget)
  return connecting
}
