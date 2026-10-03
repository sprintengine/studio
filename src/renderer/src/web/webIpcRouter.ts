import { createIpcRouter, type RendererIpc, type RouterPort } from '../../../preload/ipc-router-core'
import { SERVER_IPC_CHANNELS } from '../../../shared/ipc-channel-owners'
import { WEB_TUNNEL_CHANNELS } from '../../../shared/web-client'
import { WEB_CLOSE_REVOKED, watchWebReconnectTriggers } from './webReconnect'
import { returnToPairing, webSocketUrl, webWindowId } from './webLocation'
import { webShellIpc } from './webShellIpc'

// A web tab's IPC router: what `src/preload/ipc-router.ts` is in a desktop
// window, and what the web build puts in its place. The router is the same
// one a desktop window uses when its server runs out of process: a channel the
// server owns goes over a port to the server, and every other channel to the
// shell. Here the port is the tab's `/ws/ipc` socket, and the shell is the
// browser (`webShellIpc`).
//
// The socket reconnects by itself, with backoff, and at once when the page
// comes back online or to the foreground. While it is down, invokes wait in
// the router's queue and the idempotent reads go out again on the next socket,
// as across a server restart on the desktop. A close with 4401 means this
// browser was removed in Studio: the tab goes back to pairing.

export * from '../../../preload/ipc-router-core'

const router = createIpcRouter({
  ipcRenderer: webShellIpc,
  mode: 'out-of-process',
  table: { ...SERVER_IPC_CHANNELS, ...WEB_TUNNEL_CHANNELS },
})

function socketPort(socket: WebSocket): RouterPort {
  return {
    postMessage(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    },
    addEventListener(type: 'message' | 'close', listener: (event: { data: unknown }) => void) {
      if (type === 'message') {
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return
          let data: unknown
          try {
            data = JSON.parse(event.data)
          } catch {
            return
          }
          listener({ data })
        })
      } else socket.addEventListener('close', () => (listener as () => void)())
    },
    start: () => undefined,
    close: () => socket.close(),
  } as RouterPort
}

let attempt = 0
let timer: ReturnType<typeof setTimeout> | null = null
let current: WebSocket | null = null

function connect(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (current && current.readyState <= WebSocket.OPEN) return
  const socket = new WebSocket(webSocketUrl('ws/ipc', { windowId: webWindowId() }))
  current = socket
  socket.addEventListener('open', () => {
    attempt = 0
    router.attachPort(socketPort(socket))
  })
  socket.addEventListener('close', (event) => {
    if (current === socket) current = null
    if (event.code === WEB_CLOSE_REVOKED) {
      returnToPairing()
      return
    }
    schedule()
  })
}

function schedule(): void {
  if (timer) return
  const delay = Math.min(10_000, 250 * 2 ** attempt) * (0.75 + Math.random() * 0.5)
  attempt = Math.min(attempt + 1, 6)
  timer = setTimeout(connect, delay)
}

connect()
watchWebReconnectTriggers(() => {
  attempt = 0
  connect()
})

export const ipc: RendererIpc = router
