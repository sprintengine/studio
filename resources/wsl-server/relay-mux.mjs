// The relay's stream multiplexer (phase 8 spec, 5.4 and 6.8): many logical
// connections over one byte pipe, which for an SSH machine is the stdio of
// the one SSH session the desktop holds.
//
// Plain Node with no dependencies, because the relay runs on the remote from
// the installed server tree (`bridge.mjs --mux`), and the desktop imports the
// same file for its end, so the two ends share one codec and one flow-control
// rule rather than two copies that drift.
//
// A frame is a 9-byte header and a payload:
//
//   u32  length of what follows the length (type, stream id, payload)
//   u8   type
//   u32  stream id (chosen by the opener; never reused on one pipe)
//   …    payload
//
//   open     opener → relay   JSON { kind: 'owner', purpose } | { kind: 'tcp', host, port }
//   opened   relay → opener   empty
//   refused  relay → opener   JSON { code, message }
//   data     either way       bytes, at most MAX_DATA
//   credit   either way       u32: that many more bytes may be sent
//   fin      either way       no more data from the sender (half-close)
//   close    either way       the stream is gone both ways
//
// Each stream has its own credit window both ways, so a page that stops
// reading cannot hold up the Studio protocol beside it on the same pipe.

import { connect } from 'node:net'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Duplex } from 'node:stream'

export const MUX_VERSION = 1
export const FRAME = Object.freeze({ open: 1, opened: 2, refused: 3, data: 4, credit: 5, fin: 6, close: 7 })
export const MAX_DATA = 32 * 1024
export const INITIAL_WINDOW = 256 * 1024
export const MAX_TCP_STREAMS = 256
export const TCP_CONNECT_TIMEOUT_MS = 10_000
const HEADER = 9
const MAX_FRAME = MAX_DATA + 4_096
const EMPTY = Buffer.alloc(0)

/** One frame as bytes. */
export function encodeFrame(type, id, payload = EMPTY) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const frame = Buffer.allocUnsafe(HEADER + body.length)
  frame.writeUInt32BE(5 + body.length, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(id >>> 0, 5)
  body.copy(frame, HEADER)
  return frame
}

/** Frames out of a byte stream, across chunk edges. Throws on a frame no sender of this codec writes. */
export class FrameDecoder {
  constructor() {
    this.buffer = EMPTY
  }
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length < 5 || length > MAX_FRAME) throw new Error(`A relay frame of ${length} bytes is not one.`)
      if (this.buffer.length < 4 + length) break
      frames.push({
        type: this.buffer.readUInt8(4),
        id: this.buffer.readUInt32BE(5),
        payload: this.buffer.subarray(HEADER, 4 + length),
      })
      this.buffer = this.buffer.subarray(4 + length)
    }
    return frames
  }
}

function json(payload) {
  try {
    const value = JSON.parse(payload.toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * One logical stream: a Duplex whose writes become `data` frames as the
 * other end's credit allows, and whose reads are the other end's `data`
 * frames, granted back as credit once they are taken.
 */
class MuxStream extends Duplex {
  constructor(endpoint, id) {
    super({ allowHalfOpen: true })
    this.endpoint = endpoint
    this.id = id
    this.sendCredit = INITIAL_WINDOW
    this.pending = []
    this.owed = 0
    this.remoteEnded = false
    this.gone = false
  }
  _write(chunk, _encoding, callback) {
    if (this.gone) {
      callback(new Error('The relay stream is closed.'))
      return
    }
    for (let at = 0; at < chunk.length; at += MAX_DATA) this.pending.push(chunk.subarray(at, at + MAX_DATA))
    this.flushPending(callback)
  }
  flushPending(callback) {
    while (this.pending.length > 0 && this.sendCredit > 0) {
      let piece = this.pending[0]
      if (piece.length > this.sendCredit) {
        this.pending[0] = piece.subarray(this.sendCredit)
        piece = piece.subarray(0, this.sendCredit)
      } else this.pending.shift()
      this.sendCredit -= piece.length
      this.endpoint.send(FRAME.data, this.id, piece)
    }
    if (callback) {
      if (this.pending.length === 0) callback()
      else this.waiting = callback
    } else if (this.pending.length === 0 && this.waiting) {
      const waiting = this.waiting
      this.waiting = null
      waiting()
    }
  }
  _final(callback) {
    if (!this.gone) this.endpoint.send(FRAME.fin, this.id)
    callback()
  }
  _read() {
    this.grant()
  }
  grant() {
    if (this.owed > 0 && !this.gone && !this.remoteEnded) {
      // Zeroed before it is sent: over an in-memory pipe the other end can
      // answer the credit with data before `send` returns.
      const owed = this.owed
      this.owed = 0
      this.endpoint.send(FRAME.credit, this.id, uint32(owed))
    }
  }
  receive(payload) {
    this.owed += payload.length
    if (this.push(payload) && this.owed >= INITIAL_WINDOW / 4) this.grant()
  }
  _destroy(error, callback) {
    if (!this.gone) {
      this.gone = true
      this.endpoint.forget(this.id, true)
    }
    if (this.waiting) {
      const waiting = this.waiting
      this.waiting = null
      waiting(error ?? new Error('The relay stream is closed.'))
    }
    callback(error)
  }
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return buffer
}

/**
 * One end of the pipe. `onOpen(request, stream)` serves a stream the other
 * end asked for (the relay's side); `open(request)` asks for one (the
 * desktop's). Either end may close any stream.
 */
export class MuxEndpoint {
  constructor({ input, output, onOpen = null, onClose = null }) {
    this.output = output
    this.onOpen = onOpen
    this.streams = new Map()
    this.openers = new Map()
    this.nextId = 1
    this.closed = false
    this.closeListeners = onClose ? [onClose] : []
    const decoder = new FrameDecoder()
    input.on('data', (chunk) => {
      let frames
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        this.close(error instanceof Error ? error.message : String(error))
        return
      }
      for (const frame of frames) this.dispatch(frame)
    })
    input.on('end', () => this.close('The relay pipe ended.'))
    input.on('close', () => this.close('The relay pipe closed.'))
    input.on('error', (error) => this.close(`The relay pipe failed: ${error.message}`))
    output.on?.('error', (error) => this.close(`The relay pipe failed: ${error.message}`))
  }
  send(type, id, payload) {
    if (this.closed || this.output.destroyed || !this.output.writable) return
    this.output.write(encodeFrame(type, id, payload))
  }
  forget(id, tell) {
    if (!this.streams.delete(id)) return
    if (tell) this.send(FRAME.close, id)
  }
  dispatch(frame) {
    const stream = this.streams.get(frame.id)
    switch (frame.type) {
      case FRAME.open: {
        if (!this.onOpen || this.streams.has(frame.id)) {
          this.send(
            FRAME.refused,
            frame.id,
            JSON.stringify({ code: 'refused', message: 'Nothing here opens streams.' }),
          )
          return
        }
        const request = json(frame.payload)
        if (!request) {
          this.send(
            FRAME.refused,
            frame.id,
            JSON.stringify({ code: 'refused', message: 'The open request is not JSON.' }),
          )
          return
        }
        const created = new MuxStream(this, frame.id)
        this.streams.set(frame.id, created)
        Promise.resolve()
          .then(() => this.onOpen(request, created))
          .then(
            () => {
              if (!created.gone) this.send(FRAME.opened, frame.id)
            },
            (error) => {
              const code = typeof error?.code === 'string' ? error.code : 'refused'
              const message = error instanceof Error ? error.message : String(error)
              this.streams.delete(frame.id)
              created.gone = true
              created.destroy()
              this.send(FRAME.refused, frame.id, JSON.stringify({ code, message }))
            },
          )
        return
      }
      case FRAME.opened: {
        const opener = this.openers.get(frame.id)
        if (!opener) return
        this.openers.delete(frame.id)
        opener.resolve(this.streams.get(frame.id))
        return
      }
      case FRAME.refused: {
        const opener = this.openers.get(frame.id)
        const refusal = json(frame.payload) ?? {}
        this.openers.delete(frame.id)
        const dead = this.streams.get(frame.id)
        this.streams.delete(frame.id)
        if (dead) {
          dead.gone = true
          dead.destroy()
        }
        if (opener) {
          const error = new Error(typeof refusal.message === 'string' ? refusal.message : 'The relay refused.')
          error.code = typeof refusal.code === 'string' ? refusal.code : 'refused'
          opener.reject(error)
        }
        return
      }
      case FRAME.data:
        stream?.receive(frame.payload)
        return
      case FRAME.credit:
        if (stream && frame.payload.length === 4) {
          stream.sendCredit += frame.payload.readUInt32BE(0)
          stream.flushPending(null)
        }
        return
      case FRAME.fin:
        if (stream && !stream.remoteEnded) {
          stream.remoteEnded = true
          stream.push(null)
        }
        return
      case FRAME.close:
        if (stream) {
          this.streams.delete(frame.id)
          stream.gone = true
          stream.destroy()
        }
        return
      default:
        return
    }
  }
  /** Ask the other end for a stream; resolves once it is opened, rejects with its refusal (`error.code`). */
  open(request) {
    if (this.closed) return Promise.reject(Object.assign(new Error('The relay is not connected.'), { code: 'closed' }))
    const id = this.nextId
    this.nextId = (this.nextId + 1) >>> 0 || 1
    const stream = new MuxStream(this, id)
    this.streams.set(id, stream)
    return new Promise((resolve, reject) => {
      this.openers.set(id, { resolve, reject })
      this.send(FRAME.open, id, JSON.stringify(request))
    })
  }
  get size() {
    return this.streams.size
  }
  onClosed(listener) {
    if (this.closed) listener(this.reason)
    else this.closeListeners.push(listener)
  }
  close(reason = 'The relay closed.') {
    if (this.closed) return
    this.closed = true
    this.reason = reason
    for (const [id, opener] of this.openers) {
      this.openers.delete(id)
      opener.reject(Object.assign(new Error(reason), { code: 'closed' }))
    }
    for (const stream of this.streams.values()) {
      stream.gone = true
      stream.destroy()
    }
    this.streams.clear()
    for (const listener of this.closeListeners.splice(0)) listener(reason)
  }
}

// ── The relay's side: what an `open` reaches on the remote ─────────────────

/** The owner token's digest, as the front door's proofs are keyed by (front-door-proof.ts). */
function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function proof(hash, side, first, second, purpose) {
  return createHmac('sha256', Buffer.from(hash, 'hex')).update(`${side}\0${first}\0${second}\0${purpose}`).digest('hex')
}

function sameProof(expected, presented) {
  if (typeof presented !== 'string' || !/^[0-9a-f]{64}$/u.test(presented)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'))
}

/**
 * The front door's half of the mutual proof (front-door-proof.ts, which
 * the server runs), here on the remote: the relay proves itself with the owner
 * token it read from the server's private run directory, so the token never
 * leaves the machine. `via` and `client` go in the opening line for the
 * server's audit log.
 */
export function enterFrontDoorAsRelay(socket, { token, purpose, via, client, timeoutMs = 10_000 }) {
  const hash = tokenHash(token)
  const nonce = randomBytes(32).toString('base64url')
  socket.write(`${JSON.stringify({ t: 'front-door', v: 1, purpose, nonce, via, client, relayPid: process.pid })}\n`)
  return new Promise((resolve, reject) => {
    let buffer = EMPTY
    let proven = false
    const finish = (error) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (error) {
        socket.destroy()
        reject(error)
        return
      }
      socket.pause()
      if (buffer.length > 0) socket.unshift(buffer)
      resolve(socket)
    }
    const onError = (error) => finish(new Error(`The server's door failed: ${error.message}`))
    const onClose = () => finish(new Error("The server's door closed before it admitted the relay."))
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const newline = buffer.indexOf(0x0a)
        if (newline === -1) {
          if (buffer.length > 4_096) finish(new Error('The handshake line is too long.'))
          return
        }
        const message = json(buffer.subarray(0, newline))
        buffer = buffer.subarray(newline + 1)
        if (!proven) {
          const expected =
            message && typeof message.serverNonce === 'string'
              ? proof(hash, 'server', nonce, message.serverNonce, purpose)
              : null
          if (!message || message.t !== 'challenge' || !expected || !sameProof(expected, message.proof)) {
            finish(
              new Error(
                'Whatever holds the socket is not the Studio server: it could not prove it holds the owner token.',
              ),
            )
            return
          }
          proven = true
          socket.write(
            `${JSON.stringify({ t: 'prove', proof: proof(hash, 'client', message.serverNonce, nonce, purpose) })}\n`,
          )
          continue
        }
        if (!message || message.t !== 'admitted') {
          finish(new Error('The Studio server did not admit the relay.'))
          return
        }
        finish(null)
        return
      }
    }
    const timer = setTimeout(() => finish(new Error('The handshake with the Studio server timed out.')), timeoutMs)
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

/** What the relay found of the server in the run directory: its record, or null when none is running. */
export function readServerRecord(runDir) {
  try {
    const record = JSON.parse(readFileSync(join(runDir, 'server.json'), 'utf8'))
    return typeof record === 'object' && record !== null ? record : null
  } catch {
    return null
  }
}

function refusal(code, message) {
  return Object.assign(new Error(message), { code })
}

function tcpRefusal(error) {
  switch (error?.code) {
    case 'ECONNREFUSED':
      return refusal('refused', `Nothing is listening there (${error.message}).`)
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
      return refusal('unreachable', `That address cannot be reached from here (${error.message}).`)
    case 'ETIMEDOUT':
      return refusal('timeout', 'The connection timed out.')
    default:
      return refusal('unreachable', error instanceof Error ? error.message : String(error))
  }
}

const HOST = /^[A-Za-z0-9._:[\]%-]{1,255}$/u

/**
 * Serve the relay's side on `input`/`output`: `owner` streams to the server's
 * front-door socket (proven with the owner token, read fresh for each, so a
 * restarted server's new token is the one presented), `tcp` streams to a host
 * and port resolved here, on the remote, as the person. Counts streams,
 * targets and bytes for diagnostics; records no content.
 */
export function serveRelay({ input, output, runDir, via = 'ssh-relay', client = null, log = () => undefined }) {
  const stats = { owner: 0, tcp: 0, refused: 0, bytesIn: 0, bytesOut: 0, targets: new Set() }
  let tcpOpen = 0
  const endpoint = new MuxEndpoint({
    input,
    output,
    onOpen: async (request, stream) => {
      if (request.kind === 'owner') {
        const purpose = request.purpose
        if (purpose !== 'backend' && purpose !== 'studio')
          throw refusal('refused', 'That is not a purpose the server serves.')
        const record = readServerRecord(runDir)
        if (!record || typeof record.socketPath !== 'string')
          throw refusal('no-server', 'No Studio server is running on this machine.')
        let token
        try {
          token = readFileSync(join(runDir, 'owner-token'), 'utf8').trim()
        } catch {
          throw refusal('no-server', 'The Studio server left no owner token to prove the relay with.')
        }
        const socket = await new Promise((resolve, reject) => {
          const opened = connect({ path: record.socketPath, allowHalfOpen: true })
          opened.once('connect', () => resolve(opened))
          opened.once('error', (error) =>
            reject(refusal('no-server', `The Studio server's socket refused: ${error.message}`)),
          )
        })
        await enterFrontDoorAsRelay(socket, { token, purpose, via, client }).catch((error) => {
          throw refusal('refused', error.message)
        })
        stats.owner++
        splice(stream, socket, stats)
        return
      }
      if (request.kind === 'tcp') {
        const host = typeof request.host === 'string' ? request.host.replace(/^\[(.*)\]$/u, '$1') : ''
        const port = request.port
        if (!HOST.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535)
          throw refusal('refused', 'That is not a host and port.')
        if (tcpOpen >= MAX_TCP_STREAMS)
          throw refusal('limit', `The relay carries at most ${MAX_TCP_STREAMS} connections.`)
        tcpOpen++
        stream.once('close', () => tcpOpen--)
        const socket = await new Promise((resolve, reject) => {
          const opened = connect({ host, port, allowHalfOpen: true })
          const timer = setTimeout(() => {
            opened.destroy()
            reject(refusal('timeout', 'The connection timed out.'))
          }, TCP_CONNECT_TIMEOUT_MS)
          opened.once('connect', () => {
            clearTimeout(timer)
            resolve(opened)
          })
          opened.once('error', (error) => {
            clearTimeout(timer)
            reject(tcpRefusal(error))
          })
        }).catch((error) => {
          stats.refused++
          throw error
        })
        stats.tcp++
        if (stats.targets.size < 64) stats.targets.add(`${host}:${port}`)
        splice(stream, socket, stats)
        return
      }
      throw refusal('refused', 'The relay opens owner and tcp streams only.')
    },
  })
  endpoint.onClosed((reason) => log(`relay closed: ${reason}`))
  return { endpoint, stats }
}

/** Bytes both ways between a mux stream and a socket, half-closes carried each way. */
function splice(stream, socket, stats) {
  socket.on('data', (chunk) => {
    stats.bytesOut += chunk.length
    if (!stream.write(chunk)) socket.pause()
  })
  stream.on('drain', () => socket.resume())
  socket.on('end', () => stream.end())
  stream.on('data', (chunk) => {
    stats.bytesIn += chunk.length
    if (!socket.write(chunk)) stream.pause()
  })
  socket.on('drain', () => stream.resume())
  stream.on('end', () => socket.end())
  const both = () => {
    socket.destroy()
    stream.destroy()
  }
  socket.on('close', both)
  socket.on('error', both)
  stream.on('close', both)
  stream.on('error', both)
  socket.resume()
}
