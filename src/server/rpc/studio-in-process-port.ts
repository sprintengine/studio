import { Duplex } from 'node:stream'

import type { StudioAuth } from '../../../packages/studio-protocol/src/public'
import type { StudioTransport, StudioTransportFactory } from '../../../packages/agent-sdk/src/transport'

// A Studio connection whose two ends are in one process: the server reads and
// writes a stream, and a client holds an `@sprintengine/agent-sdk` transport.
// It is how the desktop's own shell reaches the server it runs beside, the
// same SDK every other client uses, with no socket and no credential that
// leaves the process. Once the server runs in a process of its own, the shell
// reaches it over its control channel instead, and nothing above changes.
//
// Frames cross on the next microtask in each direction, in order, so neither
// end is re-entered from inside the other's write.

/**
 * A transport factory over connections `attach` serves. Every call makes a
 * fresh pair and asks `credential` for the hello's credential, which the
 * attached connection's authenticator checks (a ticket good for one hello).
 */
export function inProcessStudioTransport(
  attach: (stream: Duplex) => void,
  credential: () => StudioAuth,
): StudioTransportFactory {
  return async () => {
    const messageListeners: Array<(frame: string) => void> = []
    const closeListeners: Array<(error?: Error) => void> = []
    let closed = false
    let pending = ''
    const end = () => {
      if (closed) return
      closed = true
      queueMicrotask(() => {
        for (const listener of closeListeners.splice(0)) listener()
      })
    }
    const server = new Duplex({
      read() {
        // Frames are pushed as the client sends them.
      },
      write(chunk: Buffer | string, _encoding, callback) {
        pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const lines: string[] = []
        for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (line) lines.push(line)
        }
        if (lines.length)
          queueMicrotask(() => {
            if (closed) return
            for (const line of lines) for (const listener of messageListeners) listener(line)
          })
        callback()
      },
      final(callback) {
        // The last frames written (a `bye`) reach the client before the close does.
        queueMicrotask(end)
        callback()
      },
      destroy(error, callback) {
        queueMicrotask(end)
        callback(error)
      },
    })
    attach(server)
    const transport: StudioTransport = {
      credential: credential(),
      send(frame) {
        if (closed) return
        queueMicrotask(() => {
          if (!closed && !server.destroyed) server.push(`${frame}\n`)
        })
      },
      close() {
        if (closed) return
        queueMicrotask(() => {
          if (!server.destroyed) {
            server.push(null)
            server.destroy()
          }
        })
        end()
      },
      onMessage: (listener) => void messageListeners.push(listener),
      onClose: (listener) => void closeListeners.push(listener),
    }
    return transport
  }
}
