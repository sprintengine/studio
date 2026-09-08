import { createHash, randomBytes } from 'crypto'

// A minimal RFC 6455 codec: handshake accept key, frame decode, frame encode.
// Hand-written for the same reason mcp-socket-server.ts hand-writes its
// JSON-RPC — the app ships no WebSocket dependency, and the slice this listener
// needs (text frames, ping/pong, close) is small and fully specified.
//
// Both roles live here. The listener is the server half; the Fleet client
// (MC-2167) dials OTHER machines from this same process, and giving it its own
// copy of the framing would be two implementations of one wire format, drifting
// against each other in a security-relevant file. The role only changes who
// masks (RFC 6455 §5.1: clients must, servers must not).
//
// What is deliberately NOT implemented, because no client of this transport
// uses it and a half-implementation would be worse than an explicit refusal:
// - extensions (`permessage-deflate` and friends) are never negotiated;
// - fragmented messages across continuation frames are refused, not buffered;
// - binary frames are refused (the payload here is JSON-RPC text).
// Each refusal closes the connection with a protocol-error close code.

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Close codes this server sends (RFC 6455 §7.4.1 plus the 4xxx private range). */
export const WEBSOCKET_CLOSE_NORMAL = 1000
export const WEBSOCKET_CLOSE_GOING_AWAY = 1001
const WEBSOCKET_CLOSE_PROTOCOL_ERROR = 1002
const WEBSOCKET_CLOSE_UNSUPPORTED_DATA = 1003
const WEBSOCKET_CLOSE_MESSAGE_TOO_BIG = 1009
/** Private-range code for a device whose access was revoked mid-stream. */
export const WEBSOCKET_CLOSE_REVOKED = 4401

/** One message may not exceed this; matches the socket transport's 1 MiB line cap. */
export const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024

export function computeWebSocketAcceptKey(clientKey: string): string {
  return createHash('sha1').update(`${clientKey}${WEBSOCKET_GUID}`).digest('base64')
}

type WebSocketFrame =
  | { kind: 'text'; text: string }
  | { kind: 'ping'; payload: Buffer }
  | { kind: 'pong' }
  /** Code/reason are carried for a client that must report WHY the peer hung up (4401 revoked, say). */
  | { kind: 'close'; code: number; reason: string }

type WebSocketDecodeResult =
  | { kind: 'frames'; frames: WebSocketFrame[] }
  | { kind: 'error'; code: number; reason: string }

export type WebSocketFrameDecoder = {
  /** Feed received bytes; returns whole frames, or the failure that must close the socket. */
  push(chunk: Buffer): WebSocketDecodeResult
}

/**
 * Which side of the connection is decoding.
 *
 * `server` requires every incoming frame to be masked, because the spec
 * requires a client to mask and an unmasked client frame is a violation the
 * server must fail on. `client` decodes frames from the listener, which are
 * never masked — but honours the mask bit anyway, because reading the bit is
 * what decoding a frame means, not an optimism about who sent it.
 */
export type WebSocketDecoderRole = 'server' | 'client'

export function createWebSocketFrameDecoder(
  maxMessageBytes: number = MAX_WEBSOCKET_MESSAGE_BYTES,
  role: WebSocketDecoderRole = 'server'
): WebSocketFrameDecoder {
  let buffer: Buffer = Buffer.alloc(0)

  return {
    push(chunk: Buffer): WebSocketDecodeResult {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      const frames: WebSocketFrame[] = []
      for (;;) {
        if (buffer.length < 2) return { kind: 'frames', frames }
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const reserved = first & 0x70
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2

        if (reserved !== 0) {
          // Reserved bits are only meaningful for an extension, and this server
          // negotiates none — so a peer setting them is speaking a dialect we
          // did not agree to, not something to interpret optimistically.
          return { kind: 'error', code: WEBSOCKET_CLOSE_PROTOCOL_ERROR, reason: 'Reserved frame bits are set but no extension was negotiated.' }
        }
        if (!masked && role === 'server') {
          // RFC 6455 §5.1: a client MUST mask. An unmasked client frame is a
          // protocol violation the spec requires the server to fail on.
          return { kind: 'error', code: WEBSOCKET_CLOSE_PROTOCOL_ERROR, reason: 'Client frames must be masked.' }
        }
        if (length === 126) {
          if (buffer.length < offset + 2) return { kind: 'frames', frames }
          length = buffer.readUInt16BE(offset)
          offset += 2
        } else if (length === 127) {
          if (buffer.length < offset + 8) return { kind: 'frames', frames }
          const extended = buffer.readBigUInt64BE(offset)
          if (extended > BigInt(maxMessageBytes)) {
            return { kind: 'error', code: WEBSOCKET_CLOSE_MESSAGE_TOO_BIG, reason: `Frame exceeds the ${maxMessageBytes}-byte limit.` }
          }
          length = Number(extended)
          offset += 8
        }
        if (length > maxMessageBytes) {
          return { kind: 'error', code: WEBSOCKET_CLOSE_MESSAGE_TOO_BIG, reason: `Frame exceeds the ${maxMessageBytes}-byte limit.` }
        }
        const maskLength = masked ? 4 : 0
        if (buffer.length < offset + maskLength + length) return { kind: 'frames', frames }

        const mask = masked ? buffer.subarray(offset, offset + 4) : null
        offset += maskLength
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
        buffer = buffer.subarray(offset + length)

        if (opcode === 0x0 || !fin) {
          return {
            kind: 'error',
            code: WEBSOCKET_CLOSE_PROTOCOL_ERROR,
            reason: 'Fragmented messages are not supported on this transport; send each JSON-RPC message as one final frame.',
          }
        }
        switch (opcode) {
          case 0x1:
            frames.push({ kind: 'text', text: payload.toString('utf8') })
            break
          case 0x8:
            frames.push({
              kind: 'close',
              // 1005 is "no status present", the code RFC 6455 reserves for
              // exactly this: a close body too short to carry one.
              code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
              reason: payload.length > 2 ? payload.subarray(2).toString('utf8') : '',
            })
            return { kind: 'frames', frames }
          case 0x9:
            frames.push({ kind: 'ping', payload })
            break
          case 0xa:
            frames.push({ kind: 'pong' })
            break
          default:
            return {
              kind: 'error',
              code: WEBSOCKET_CLOSE_UNSUPPORTED_DATA,
              reason: `Opcode 0x${opcode.toString(16)} is not supported; this transport carries JSON-RPC text frames.`,
            }
        }
      }
    },
  }
}

export function encodeTextFrame(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, 'utf8'))
}

export function encodePongFrame(payload: Buffer): Buffer {
  return encodeFrame(0xa, payload)
}

export function encodeCloseFrame(code: number, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8')
  // The close body is a 2-byte code plus an optional reason, capped at 125
  // bytes total because close is a control frame.
  const payload = Buffer.concat([Buffer.alloc(2), reasonBytes.subarray(0, 123)])
  payload.writeUInt16BE(code, 0)
  return encodeFrame(0x8, payload)
}

/** A text frame from the CLIENT half, masked as the spec requires. */
export function encodeMaskedTextFrame(text: string): Buffer {
  return encodeMaskedFrame(0x1, Buffer.from(text, 'utf8'))
}

export function encodeMaskedCloseFrame(code: number, reason = ''): Buffer {
  const payload = Buffer.concat([Buffer.alloc(2), Buffer.from(reason, 'utf8').subarray(0, 123)])
  payload.writeUInt16BE(code, 0)
  return encodeMaskedFrame(0x8, payload)
}

export function encodeMaskedPongFrame(payload: Buffer): Buffer {
  return encodeMaskedFrame(0xa, payload)
}

/**
 * Client frames MUST be masked with a fresh random key per frame (RFC 6455
 * §5.3). The mask is not a secret and buys nothing against a reader — it exists
 * so intermediaries cannot be tricked into parsing frame bytes as a request —
 * but the listener refuses unmasked client frames, so this is also simply what
 * it takes to be understood.
 */
function encodeMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : payload.length < 65536
        ? (() => {
            const bytes = Buffer.alloc(4)
            bytes[0] = 0x80 | opcode
            bytes[1] = 0x80 | 126
            bytes.writeUInt16BE(payload.length, 2)
            return bytes
          })()
        : (() => {
            const bytes = Buffer.alloc(10)
            bytes[0] = 0x80 | opcode
            bytes[1] = 0x80 | 127
            bytes.writeBigUInt64BE(BigInt(payload.length), 2)
            return bytes
          })()
  return Buffer.concat([header, mask, masked])
}

/** Server frames are never masked (RFC 6455 §5.1). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? (() => {
            const bytes = Buffer.alloc(4)
            bytes[0] = 0x80 | opcode
            bytes[1] = 126
            bytes.writeUInt16BE(payload.length, 2)
            return bytes
          })()
        : (() => {
            const bytes = Buffer.alloc(10)
            bytes[0] = 0x80 | opcode
            bytes[1] = 127
            bytes.writeBigUInt64BE(BigInt(payload.length), 2)
            return bytes
          })()
  return Buffer.concat([header, payload])
}
