import type { IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'

import {
  WEBSOCKET_CLOSE_GOING_AWAY,
  WEBSOCKET_CLOSE_NORMAL,
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  enableTcpKeepAlive,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  encodeTextFrame,
} from '../../main/automation/tailnet/websocket-frames'
import { assertJsonSafe } from '../../shared/json-safe'
import type { TunnelPort } from '../ipc/ipc-tunnel'

// One browser WebSocket on the web listener, over the app's own RFC 6455
// codec (the tailnet lane's; the app ships no WebSocket dependency), and the
// two shapes the server reads it as: a Studio connection's stream, and a
// window's IPC tunnel port.
//
// Heartbeats are protocol pings, which a browser answers by itself however
// hard it throttles a background tab's timers: one every 25 seconds, and a
// socket that has said nothing for 60 is closed. A close the browser sees is
// a reconnect, which resumes every stream from its cursor.

/** The largest message a browser may send; the protocol skips oversized frames below this on its own. */
const MAX_WEB_MESSAGE_BYTES = 16 * 1024 * 1024
const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 60_000
/** The private close code a revoked session's sockets close with (phase 9 spec, 6.1). */
export const WEB_CLOSE_REVOKED = 4401

export type WebSocketPeer = {
  /** Send one text message; false when the socket's buffer is full and the caller should wait for `whenDrained`. */
  send(text: string): boolean
  whenDrained(listener: () => void): void
  onText(listener: (text: string) => void): void
  /** Fires once, when the socket is gone for any reason. */
  onClose(listener: () => void): void
  close(code?: number, reason?: string): void
  isOpen(): boolean
}

/** Whether an upgrade is a WebSocket upgrade this codec can accept; the error names what is wrong. */
export function webSocketKeyOf(request: IncomingMessage): { ok: true; key: string } | { ok: false; code: string } {
  if ((request.headers.upgrade ?? '').toLowerCase() !== 'websocket')
    return { ok: false, code: 'not_a_websocket_upgrade' }
  if (request.headers['sec-websocket-version'] !== '13') return { ok: false, code: 'unsupported_websocket_version' }
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || key.length === 0) return { ok: false, code: 'missing_websocket_key' }
  return { ok: true, key }
}

/** Refuse an upgrade with an HTTP status before any WebSocket exists. */
export function refuseUpgrade(socket: Duplex, status: number, code: string): void {
  const reason =
    status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request'
  if (!socket.destroyed) {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nX-Studio-Error: ${code}\r\n\r\n`,
    )
  }
  socket.destroy()
}

/** Complete the handshake and wrap the socket. */
export function acceptWebSocket(
  socket: Duplex,
  key: string,
  head: Buffer,
  options: { pingIntervalMs?: number; pongTimeoutMs?: number } = {},
): WebSocketPeer {
  enableTcpKeepAlive(socket)
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${computeWebSocketAcceptKey(key)}`,
      '',
      '',
    ].join('\r\n'),
  )
  const decoder = createWebSocketFrameDecoder(MAX_WEB_MESSAGE_BYTES)
  const textListeners: Array<(text: string) => void> = []
  const closeListeners: Array<() => void> = []
  let open = true
  let heardAt = Date.now()
  const pongTimeoutMs = options.pongTimeoutMs ?? PONG_TIMEOUT_MS

  const finish = (): void => {
    if (!open) return
    open = false
    clearInterval(heartbeat)
    for (const listener of closeListeners.splice(0)) {
      try {
        listener()
      } catch {
        // One listener's failure is not the socket's.
      }
    }
  }
  const close = (code = WEBSOCKET_CLOSE_NORMAL, reason = ''): void => {
    if (!open) return
    try {
      if (!socket.destroyed) socket.write(encodeCloseFrame(code, reason))
    } catch {
      // Gone already.
    }
    finish()
    socket.end()
    // A peer that never answers the close is not waited on for long.
    setTimeout(() => socket.destroy(), 1_000).unref()
  }

  const heartbeat = setInterval(() => {
    if (Date.now() - heardAt > pongTimeoutMs) {
      close(WEBSOCKET_CLOSE_GOING_AWAY, 'No answer to pings.')
      return
    }
    if (!socket.destroyed) socket.write(encodePingFrame())
  }, options.pingIntervalMs ?? PING_INTERVAL_MS)
  heartbeat.unref()

  const consume = (chunk: Buffer): void => {
    heardAt = Date.now()
    const decoded = decoder.push(chunk)
    if (decoded.kind === 'error') {
      close(decoded.code, decoded.reason)
      return
    }
    for (const frame of decoded.frames) {
      if (!open) return
      if (frame.kind === 'text') for (const listener of [...textListeners]) listener(frame.text)
      else if (frame.kind === 'ping') socket.write(encodePongFrame(frame.payload))
      else if (frame.kind === 'close') {
        close(WEBSOCKET_CLOSE_NORMAL, '')
        return
      }
    }
  }
  socket.on('data', consume)
  socket.on('close', finish)
  socket.on('error', finish)
  if (head.length > 0) queueMicrotask(() => consume(head))

  return {
    send(text) {
      if (!open || socket.destroyed) return true
      return socket.write(encodeTextFrame(text))
    },
    whenDrained(listener) {
      if (!open || socket.destroyed || !socket.writableNeedDrain) queueMicrotask(listener)
      else socket.once('drain', listener)
    },
    onText: (listener) => void textListeners.push(listener),
    onClose(listener) {
      if (open) closeListeners.push(listener)
      else queueMicrotask(listener)
    },
    close,
    isOpen: () => open,
  }
}

/**
 * The socket as the stream a Studio connection reads and writes: each message
 * in is one line, and each line written goes out as one message. Unlike a
 * window's port, a browser can be slow to read, so a write waits for the
 * socket to drain: what is waiting then sits in the connection's own bounded
 * queue, where a reader that stopped is noticed, and not in the kernel's.
 */
export function webSocketStream(peer: WebSocketPeer): Duplex {
  let pending = ''
  const stream = new Duplex({
    read() {
      // Messages are pushed as they arrive.
    },
    write(chunk: Buffer | string, _encoding, callback) {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let full = false
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const frame = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (frame && !peer.send(frame)) full = true
        newline = pending.indexOf('\n')
      }
      if (full) peer.whenDrained(() => callback())
      else callback()
    },
    final(callback) {
      // The last frames (a `bye`) are written; the close follows them.
      setImmediate(() => peer.close())
      callback()
    },
    destroy(error, callback) {
      peer.close()
      callback(error)
    },
  })
  peer.onText((text) => {
    stream.push(`${text}\n`)
  })
  peer.onClose(() => {
    stream.push(null)
    stream.destroy()
  })
  return stream
}

/**
 * The socket as a window's IPC tunnel port. A window's port carries structured
 * clones; this one carries JSON, so a value that does not survive JSON (a
 * `Date`, a `Map`, bytes) is refused out loud rather than sent changed: a
 * result as a failed call, a push as a logged drop.
 */
export function tunnelPortOf(peer: WebSocketPeer): TunnelPort {
  const messageListeners: Array<(event: { data: unknown }) => void> = []
  peer.onText((text) => {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return
    }
    for (const listener of [...messageListeners]) listener({ data })
  })
  const port: TunnelPort = {
    postMessage: (message) => {
      try {
        assertJsonSafe(message, 'message')
      } catch (error) {
        // A result that would arrive mangled arrives as the failure it is, so
        // the call fails where it was made; a push is dropped, out loud.
        const frame = message as { t?: unknown; id?: unknown; channel?: unknown } | null
        console.error(`[web tunnel] ${error instanceof Error ? error.message : String(error)}`)
        if (frame?.t === 'ipc.result')
          peer.send(
            JSON.stringify({
              t: 'ipc.result',
              id: frame.id,
              ok: false,
              error: { name: 'NotJsonSafe', message: error instanceof Error ? error.message : String(error) },
            }),
          )
        return
      }
      peer.send(JSON.stringify(message))
    },
    on: ((event: 'message' | 'close', listener: (event: { data: unknown }) => void) => {
      if (event === 'message') messageListeners.push(listener)
      else peer.onClose(() => (listener as () => void)())
      return port
    }) as TunnelPort['on'],
    start: () => undefined,
    close: () => peer.close(),
  }
  return port
}
