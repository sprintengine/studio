import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'

import type { ElectronApi } from '../../shared/electron-api'
import { readStudioEnv } from '../../shared/studio-env'
import {
  STUDIO_CHAT_TRANSPORT_ENV,
  STUDIO_CONNECT_CHANNEL,
  STUDIO_PORT_CHANNEL,
  studioChatTransportMode,
  type StudioConnectResult,
} from '../../shared/studio-connection'

// This window's connections to the Studio RPC. Main transfers each one's port
// here; the port stays in the preload's world and the page is lent four
// functions over it, by connection id. Nothing the page holds outlives the
// connection: its ticket is spent by the hello it is minted for.

/** How long a connection's port may lag the answer that named it. */
const PORT_WAIT_MS = 10_000

type PortLike = Pick<MessagePort, 'postMessage' | 'addEventListener' | 'start' | 'close'>

/** The slice of `ipcRenderer` this reads: tests hand in their own. */
type Ipc = {
  invoke(channel: string): Promise<unknown>
  on(channel: string, listener: (event: { ports: readonly PortLike[] }, payload: unknown) => void): unknown
}

type StudioConnectionApi = Pick<
  ElectronApi,
  'studioChatTransport' | 'studioConnect' | 'studioPortSend' | 'studioPortListen' | 'studioPortClose'
>

export function createStudioConnectionApi(
  ipc: Ipc,
  options: { mode?: string; portWaitMs?: number } = {},
): StudioConnectionApi {
  // A port that arrived before the answer that names it, or an answer waiting for its port.
  const arrived = new Map<string, PortLike>()
  const waiting = new Map<string, (port: PortLike) => void>()
  const ports = new Map<string, PortLike>()
  const portWaitMs = options.portWaitMs ?? PORT_WAIT_MS

  // Heard from the first connect on: a window that never asks for one never listens.
  let listening = false
  function listen(): void {
    if (listening) return
    listening = true
    ipc.on(STUDIO_PORT_CHANNEL, (event, payload) => {
      const port = event.ports[0]
      const connectionId = (payload as { connectionId?: unknown } | null)?.connectionId
      if (!port || typeof connectionId !== 'string') return
      const take = waiting.get(connectionId)
      if (take) {
        waiting.delete(connectionId)
        take(port)
      } else arrived.set(connectionId, port)
    })
  }

  function portFor(connectionId: string): Promise<PortLike> {
    const early = arrived.get(connectionId)
    if (early) {
      arrived.delete(connectionId)
      return Promise.resolve(early)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(connectionId)
        reject(new Error('Studio did not hand this window its connection.'))
      }, portWaitMs)
      waiting.set(connectionId, (port) => {
        clearTimeout(timer)
        resolve(port)
      })
    })
  }

  return {
    studioChatTransport: studioChatTransportMode(options.mode),
    studioConnect: async (): Promise<StudioConnectResult> => {
      listen()
      const connection = (await ipc.invoke(STUDIO_CONNECT_CHANNEL)) as StudioConnectResult
      ports.set(connection.connectionId, await portFor(connection.connectionId))
      return connection
    },
    studioPortSend: (connectionId, frame) => {
      ports.get(connectionId)?.postMessage(frame)
    },
    studioPortListen: (connectionId, onFrame, onClose) => {
      const port = ports.get(connectionId)
      if (!port) {
        onClose()
        return
      }
      port.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data === 'string') onFrame(event.data)
      })
      // Electron tells a renderer's port when the other end goes, which the web's ports do not.
      port.addEventListener('close', () => {
        ports.delete(connectionId)
        onClose()
      })
      port.start()
    },
    studioPortClose: (connectionId) => {
      const port = ports.get(connectionId)
      ports.delete(connectionId)
      port?.close()
    },
  }
}

export const studioConnectionApi = createStudioConnectionApi(
  {
    invoke: (channel) => ipcRenderer.invoke(channel),
    on: (channel, listener) =>
      ipcRenderer.on(channel, (event: IpcRendererEvent, payload: unknown) => listener(event, payload)),
  },
  { mode: readStudioEnv(STUDIO_CHAT_TRANSPORT_ENV) },
)
