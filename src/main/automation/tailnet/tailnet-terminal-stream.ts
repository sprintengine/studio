import type { Duplex } from 'stream'

import type {
  TerminalAttachFrame,
  TerminalAttachScope,
  TerminalAttachment,
  TerminalRemoteHost,
} from '../../terminal-remote-attach'
import { tailnetScopeGrantsAccess, type TailnetScope } from '../../../shared/tailnet'
import {
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePongFrame,
  encodeTextFrame,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_CLOSE_GOING_AWAY,
  WEBSOCKET_CLOSE_NORMAL,
} from './websocket-frames'

// One attached terminal, over one WebSocket (MC-2165).
//
// Deliberately its OWN socket rather than another channel multiplexed onto the
// JSON-RPC stream: a terminal printing a build log is the chattiest thing this
// transport carries, and sharing a socket would let it queue behind — or ahead
// of — the structured tool calls. Separate sockets also make the backpressure
// story per attachment, which is the acceptance the item asks for.
//
// The frames are plain JSON objects, not JSON-RPC: this channel is a stream
// with two client verbs, and wrapping it in request/response envelopes would
// invent ids nothing correlates.

/** Client→server frames. Anything else is answered with `unknown_frame`. */
type TerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }

export type TailnetTerminalStream = {
  deviceId: string
  sessionId: string
  /** Close the socket, telling the client why. */
  close(code: number, reason: string): void
  /** True once the underlying socket is gone. */
  isClosed(): boolean
}

export type TailnetTerminalStreamOptions = {
  socket: Duplex
  sessionId: string
  deviceId: string
  deviceName: string
  scopes: readonly TailnetScope[]
  terminals: TerminalRemoteHost
  /** Called once when the socket is finished, so the server can forget it. */
  onClosed: () => void
  log?: (message: string) => void
}

/**
 * The attach scope a device's grants allow, or null when it may not attach.
 *
 * Control is a superset of observe here for the same reason `operate` implies
 * `read`: a device trusted to type into a terminal is necessarily trusted to
 * see it, and the reverse never holds.
 */
export function terminalAttachScopeFor(scopes: readonly TailnetScope[]): TerminalAttachScope | null {
  const granted = new Set<TailnetScope>(scopes)
  if (granted.has('terminal:control')) return 'control'
  return tailnetScopeGrantsAccess(granted, 'terminal:observe') ? 'observe' : null
}

/**
 * Drive one already-upgraded terminal socket.
 *
 * The caller has authenticated the ticket and written the 101; from here this
 * owns the framing, the attachment, and the socket's lifetime.
 */
export function createTailnetTerminalStream(options: TailnetTerminalStreamOptions): TailnetTerminalStream {
  const { socket } = options
  let closed = false
  let attachment: TerminalAttachment | null = null

  const send = (payload: Record<string, unknown>): void => {
    if (closed || socket.destroyed) return
    socket.write(encodeTextFrame(JSON.stringify(payload)))
  }

  const close = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    attachment?.detach()
    attachment = null
    if (!socket.destroyed) {
      try {
        socket.write(encodeCloseFrame(code, reason))
      } catch {
        // The peer is already gone; ending below is the whole cleanup.
      }
      socket.end()
    }
    options.onClosed()
  }

  const scope = terminalAttachScopeFor(options.scopes)
  if (!scope) {
    // Reached only if the caller upgraded a device without a terminal grant;
    // refuse in the stream too rather than trusting one gate.
    send({
      type: 'error',
      code: 'terminal_scope_required',
      message: 'This device is not granted terminal access. Re-pair it with the terminal watch or control scope.',
    })
    close(WEBSOCKET_CLOSE_NORMAL, 'terminal_scope_required')
    return { deviceId: options.deviceId, sessionId: options.sessionId, close, isClosed: () => closed }
  }

  const attached = options.terminals.attach({
    sessionId: options.sessionId,
    scope,
    transport: {
      viewerId: `tailnet:${options.deviceId}:${options.sessionId}:${nextViewerSequence()}`,
      send: (frame: TerminalAttachFrame) => send({ ...frame }),
      isOpen: () => !closed && !socket.destroyed,
      // Node buffers unwritten bytes in memory; this is how far behind the peer
      // is, and the runtime drops-and-resyncs rather than growing it.
      queuedBytes: () => socket.writableLength,
    },
  })

  if (!attached.ok) {
    send({ type: 'error', code: attached.code, message: attached.message })
    close(WEBSOCKET_CLOSE_NORMAL, attached.code)
    return { deviceId: options.deviceId, sessionId: options.sessionId, close, isClosed: () => closed }
  }
  attachment = attached.attachment

  // Sent AFTER the attach replay so the client's first frame is always the
  // scrollback: a header arriving first would tempt a client to paint an empty
  // screen and then be repainted.
  send({
    type: 'attached',
    sessionId: attachment.sessionId,
    scope: attachment.scope,
    session: attachment.session as unknown as Record<string, unknown>,
  })

  const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES)

  const handleText = (text: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      send({ type: 'error', code: 'invalid_json', message: 'Terminal frames must be JSON objects.' })
      return
    }
    const frame = asClientFrame(parsed)
    if (!frame) {
      send({
        type: 'error',
        code: 'unknown_frame',
        message: 'This channel accepts {"type":"input","data":"…"} and {"type":"resize","cols":N,"rows":N}.',
      })
      return
    }
    if (!attachment) return
    // Frame-level scope enforcement. An observe-scoped socket sending input is
    // refused HERE, before the runtime is asked, and the violation is logged:
    // it is a security event, not a client mistake to swallow.
    if (scope !== 'control') {
      options.log?.(
        `tailnet terminal: device ${options.deviceName} (${options.deviceId}) sent "${frame.type}" on a watch-only attach to ${options.sessionId}; dropped.`
      )
      send({
        type: 'error',
        code: 'terminal_control_required',
        message: 'This connection is attached to watch only. Re-pair the device with the terminal control scope to type into it.',
      })
      return
    }
    const outcome = frame.type === 'input'
      ? attachment.write(frame.data)
      : attachment.resize(frame.cols, frame.rows)
    if (!outcome.ok) send({ type: 'error', code: outcome.code, message: outcome.message })
  }

  const consume = (chunk: Buffer): void => {
    const decoded = decoder.push(chunk)
    if (decoded.kind === 'error') {
      close(decoded.code, decoded.reason)
      return
    }
    for (const frame of decoded.frames) {
      if (frame.kind === 'close') {
        close(WEBSOCKET_CLOSE_GOING_AWAY, '')
        return
      }
      if (frame.kind === 'ping') {
        if (!closed && !socket.destroyed) socket.write(encodePongFrame(frame.payload))
        continue
      }
      if (frame.kind !== 'text') continue
      handleText(frame.text)
    }
  }

  const forget = (): void => {
    if (closed) return
    closed = true
    attachment?.detach()
    attachment = null
    options.onClosed()
  }

  socket.on('data', (chunk: Buffer) => consume(chunk))
  // An upgraded socket is half-open: when the peer disconnects, Node emits
  // `end` and NOT `close` (the write side is still ours). Listening only for
  // `close` would leave the viewer attached to a pty nobody is reading, which
  // is precisely the leak a long-lived stream cannot afford.
  socket.on('end', () => {
    forget()
    socket.destroy()
  })
  socket.on('close', forget)
  socket.on('error', () => {
    attachment?.detach()
    attachment = null
    if (!closed) {
      closed = true
      options.onClosed()
    }
    socket.destroy()
  })

  return { deviceId: options.deviceId, sessionId: options.sessionId, close, isClosed: () => closed }
}

// Viewer ids must be unique per socket, including two attaches from the same
// device to the same session (the item's "a second concurrent viewer" case).
let viewerSequence = 0
function nextViewerSequence(): number {
  viewerSequence += 1
  return viewerSequence
}

function asClientFrame(value: unknown): TerminalClientFrame | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.type === 'input' && typeof record.data === 'string') {
    return { type: 'input', data: record.data }
  }
  if (record.type === 'resize' && isPositiveInteger(record.cols) && isPositiveInteger(record.rows)) {
    return { type: 'resize', cols: record.cols, rows: record.rows }
  }
  return null
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
