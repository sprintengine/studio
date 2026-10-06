import type { ElectronApi } from '../../../shared/electron-api'
import { WEB_CLOSE_REVOKED } from './webReconnect'
import { randomId, returnToPairing, webSocketUrl } from './webLocation'
import { markStudioOnAnotherMachine } from '../studio/windowStudioClient'

// A web tab's connections to the Studio protocol: the four port functions a
// desktop window's preload lends the page, over a WebSocket to `/ws` instead
// of a message port main hands it. The socket's upgrade carries the session
// cookie, which the server checks with the `Origin`; the hello's credential is
// a placeholder the server does not read, because the upgrade already proved
// who this is (phase 9 spec, 3.5). Everything above (the window's client, its
// reconnects and resumes) is unchanged.

/** The credential a cookie-authenticated socket says hello with (a credential is 16 to 256 printable characters). The server reads the session, not this. */
export const WEB_SESSION_CREDENTIAL = 'web-session-cookie'

type PortApi = Pick<ElectronApi, 'studioConnect' | 'studioPortSend' | 'studioPortListen' | 'studioPortClose'>

export function createWebStudioPorts(): PortApi {
  const sockets = new Map<string, WebSocket>()
  const ports: PortApi = {
    studioConnect: () =>
      new Promise((resolve, reject) => {
        const connectionId = `web-${randomId(6)}`
        const socket = new WebSocket(webSocketUrl('ws'))
        const fail = () => {
          socket.removeEventListener('open', opened)
          reject(new Error('Studio could not be reached from this browser.'))
        }
        const opened = () => {
          socket.removeEventListener('error', fail)
          sockets.set(connectionId, socket)
          resolve({ connectionId, ticket: WEB_SESSION_CREDENTIAL })
        }
        socket.addEventListener('open', opened, { once: true })
        socket.addEventListener('error', fail, { once: true })
        socket.addEventListener('close', (event) => {
          if (event.code === WEB_CLOSE_REVOKED) returnToPairing()
        })
      }),
    studioPortSend: (connectionId, frame) => {
      const socket = sockets.get(connectionId)
      if (socket?.readyState === WebSocket.OPEN) socket.send(frame)
    },
    studioPortListen: (connectionId, onFrame, onClose) => {
      const socket = sockets.get(connectionId)
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        sockets.delete(connectionId)
        onClose()
        return
      }
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') onFrame(event.data)
      })
      socket.addEventListener('close', () => {
        sockets.delete(connectionId)
        onClose()
      })
    },
    studioPortClose: (connectionId) => {
      const socket = sockets.get(connectionId)
      sockets.delete(connectionId)
      socket?.close()
    },
  }
  // The tab's Studio is the machine that served it, not this device.
  markStudioOnAnotherMachine(ports.studioConnect)
  return ports
}
