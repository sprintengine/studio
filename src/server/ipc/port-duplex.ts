import { Duplex } from 'node:stream'

import type { TunnelPort } from './ipc-tunnel'

// A byte stream over a message port: how an SSH machine's relay stream (held
// by main) reaches the desktop's server when it runs as a process of its own
// (phase 8 with phase 6). Each chunk is one message, `{ b: bytes }`; `{ end }`
// says the sender has finished; the port closing ends the stream both ways.
// Either end uses it: main splices it onto the relay's stream, the server
// reads its conversation wire from it.

type PortMessage = { b?: Uint8Array; end?: true }

export function portDuplex(port: TunnelPort): Duplex {
  let closed = false
  const stream = new Duplex({
    allowHalfOpen: true,
    read() {
      // Messages are pushed as they come; a port has no back-pressure to apply.
    },
    write(chunk: Buffer, _encoding, callback) {
      if (closed) {
        callback(new Error('The port is closed.'))
        return
      }
      // A copy of this chunk alone: a view on a pooled Buffer would clone the
      // whole pool, other streams' bytes with it.
      port.postMessage({ b: Uint8Array.prototype.slice.call(chunk) } satisfies PortMessage)
      callback()
    },
    final(callback) {
      if (!closed) port.postMessage({ end: true } satisfies PortMessage)
      callback()
    },
    destroy(error, callback) {
      if (!closed) {
        closed = true
        port.close()
      }
      callback(error)
    },
  })
  port.on('message', (event) => {
    const message = event.data as PortMessage | null
    if (!message || typeof message !== 'object') return
    if (message.b) stream.push(Buffer.from(message.b))
    if (message.end) stream.push(null)
  })
  port.on('close', () => {
    if (closed) return
    closed = true
    stream.push(null)
    stream.destroy()
  })
  port.start()
  return stream
}

/** Bytes both ways between a stream and a port, until either ends. */
export function splicePort(port: TunnelPort, stream: Duplex): void {
  const over = portDuplex(port)
  stream.pipe(over)
  over.pipe(stream)
  const end = () => {
    over.destroy()
    stream.destroy()
  }
  stream.once('close', end)
  over.once('close', end)
  stream.on('error', end)
  over.on('error', end)
}
