import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'

// How the Windows side and a Studio server inside a WSL distribution prove
// who they are to each other before either says anything that matters
// (phase 7 spec, 4.2).
//
// The server's loopback listener is reached through WSL's localhost
// forwarding. If another Windows process already holds that port number on
// Windows' own loopback, the forwarding cannot claim it and the Windows side
// reaches that process instead; Windows' loopback is also open to every
// session on the PC. So the front door never sends a secret first. It sends a
// nonce; the server answers with an HMAC over both ends' nonces keyed by the
// owner token, which only the real server knows (it was handed the token's
// hash in its bootstrap envelope, over the starter's stdin); only then does
// the front door prove itself the same way. An impostor learns nothing it
// could replay, and the front door never takes a prompt from one.
//
// The same exchange runs over the stdio bridge, where it costs nothing, so
// there is one handshake whatever carries the bytes.
//
// The wire is one JSON line per step, then whatever the purpose speaks:
//
//   front door → server   {"t":"front-door","v":1,"purpose":…,"nonce":…}
//   server → front door   {"t":"challenge","serverNonce":…,"proof":…}
//   front door → server   {"t":"prove","proof":…}
//   server → front door   {"t":"admitted"}
//
// Anything else, or a proof that does not verify, ends the connection with
// nothing further said. Private to the app (both ends are one build, the
// server tree being installed per app version), so it carries a version only
// to refuse a mismatch in words.

export const FRONT_DOOR_PROOF_VERSION = 1

/** What a connection is for once it is admitted. */
export type FrontDoorPurpose =
  /** The conversation backend the front door routes a distribution's chats to. */
  | 'backend'
  /** A Studio protocol connection, as the shell role (the toolsets the front door offers). */
  | 'studio'

const PURPOSES: ReadonlySet<string> = new Set<FrontDoorPurpose>(['backend', 'studio'])
const NONCE_BYTES = 32
// A preamble line is a few hundred bytes; anything longer is not one.
const MAX_PREAMBLE_LINE = 4_096
export const DEFAULT_FRONT_DOOR_TIMEOUT_MS = 10_000

/** The owner token's digest, as the envelope carries it and the proofs are keyed by. */
export function ownerTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function proof(tokenHash: string, side: 'server' | 'client', first: string, second: string, purpose: string): string {
  return createHmac('sha256', Buffer.from(tokenHash, 'hex'))
    .update(`${side}\0${first}\0${second}\0${purpose}`)
    .digest('hex')
}

/** What the server proves: it holds the token, for this nonce pair and purpose. */
export function serverProof(tokenHash: string, nonce: string, serverNonce: string, purpose: string): string {
  return proof(tokenHash, 'server', nonce, serverNonce, purpose)
}

/** What the front door proves in turn. The nonces are in the other order, so a server proof is never a client one. */
export function clientProof(tokenHash: string, nonce: string, serverNonce: string, purpose: string): string {
  return proof(tokenHash, 'client', serverNonce, nonce, purpose)
}

/** Compares two hex proofs in constant time; false for anything that is not one. */
export function proofsMatch(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || !/^[0-9a-f]{64}$/u.test(presented)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'))
}

export function freshNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url')
}

function validNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value)
}

export class FrontDoorRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontDoorRefusedError'
  }
}

/**
 * Reads JSON lines off a stream until `step` says it is done, then hands back
 * what arrived after the last line it read, so the next protocol starts with
 * every byte. It reads with `read()` on `readable`, never in flowing mode, so
 * once it lets go the stream is in no mode at all: whoever reads next with a
 * `data` listener or a `pipe` starts it flowing, from the unshifted bytes on.
 */
function readPreamble(
  stream: Duplex,
  timeoutMs: number,
  step: (message: Record<string, unknown>) => 'more' | 'done',
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.off('readable', onReadable)
      stream.off('error', onError)
      stream.off('close', onClose)
      if (error) reject(error)
      else {
        if (buffer.length > 0) stream.unshift(buffer)
        resolve()
      }
    }
    const onError = (error: Error): void => finish(new FrontDoorRefusedError(`The connection failed: ${error.message}`))
    const onClose = (): void => finish(new FrontDoorRefusedError('The other end closed the connection.'))
    const onReadable = (): void => {
      let chunk: Buffer | string | null
      while (!settled && (chunk = stream.read() as Buffer | string | null) !== null) take(chunk)
    }
    const take = (chunk: Buffer | string): void => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk])
      for (;;) {
        const newline = buffer.indexOf(0x0a)
        if (newline === -1) {
          if (buffer.length > MAX_PREAMBLE_LINE) finish(new FrontDoorRefusedError('The handshake line is too long.'))
          return
        }
        const line = buffer.subarray(0, newline).toString('utf8').trim()
        buffer = buffer.subarray(newline + 1)
        if (!line) continue
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          finish(new FrontDoorRefusedError('The handshake line is not JSON.'))
          return
        }
        if (typeof message !== 'object' || message === null || Array.isArray(message)) {
          finish(new FrontDoorRefusedError('The handshake line is not an object.'))
          return
        }
        let next: 'more' | 'done'
        try {
          next = step(message as Record<string, unknown>)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (next === 'done') {
          finish(null)
          return
        }
      }
    }
    const timer = setTimeout(
      () => finish(new FrontDoorRefusedError(`The handshake did not finish within ${timeoutMs} ms.`)),
      timeoutMs,
    )
    timer.unref?.()
    stream.on('readable', onReadable)
    stream.on('error', onError)
    stream.on('close', onClose)
  })
}

function sendLine(stream: Duplex, message: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(message)}\n`)
}

/**
 * The server's half: admit a connection that proves it holds the owner token,
 * and say which purpose it asked for. A connection that does not is closed,
 * having learned only the server's proof for a nonce it chose.
 */
/**
 * Who came in, for the server's audit log: an SSH machine's relay says so
 * (`via: 'ssh-relay'`), with the SSH client's address and its own pid. Only
 * ever logged, never trusted: the proof is what admits a connection.
 */
export type FrontDoorVia = { via: string; client: string | null; relayPid: number | null }

function viaOf(message: Record<string, unknown>): FrontDoorVia | null {
  if (typeof message.via !== 'string' || !/^[a-z-]{1,32}$/u.test(message.via)) return null
  const client =
    typeof message.client === 'string' && /^[0-9A-Fa-f.:%a-z-]{1,64}$/u.test(message.client) ? message.client : null
  const relayPid = Number.isInteger(message.relayPid) ? (message.relayPid as number) : null
  return { via: message.via, client, relayPid }
}

export async function admitFrontDoor(
  stream: Duplex,
  options: { tokenHash: string; timeoutMs?: number; serverNonce?: string },
): Promise<{ purpose: FrontDoorPurpose; via: FrontDoorVia | null }> {
  const serverNonce = options.serverNonce ?? freshNonce()
  let nonce = ''
  let via: FrontDoorVia | null = null
  let purpose: FrontDoorPurpose | null = null
  try {
    await readPreamble(stream, options.timeoutMs ?? DEFAULT_FRONT_DOOR_TIMEOUT_MS, (message) => {
      if (purpose === null) {
        if (message.t !== 'front-door') throw new FrontDoorRefusedError('This listener speaks only to the front door.')
        if (message.v !== FRONT_DOOR_PROOF_VERSION)
          throw new FrontDoorRefusedError(
            `The front door speaks handshake ${String(message.v)}, and this server ${FRONT_DOOR_PROOF_VERSION}.`,
          )
        if (!validNonce(message.nonce)) throw new FrontDoorRefusedError('The front door sent no usable nonce.')
        if (typeof message.purpose !== 'string' || !PURPOSES.has(message.purpose))
          throw new FrontDoorRefusedError('The front door asked for nothing this server serves.')
        nonce = message.nonce
        purpose = message.purpose as FrontDoorPurpose
        via = viaOf(message)
        sendLine(stream, {
          t: 'challenge',
          serverNonce,
          proof: serverProof(options.tokenHash, nonce, serverNonce, purpose),
        })
        return 'more'
      }
      if (
        message.t !== 'prove' ||
        !proofsMatch(clientProof(options.tokenHash, nonce, serverNonce, purpose), message.proof)
      )
        throw new FrontDoorRefusedError('The front door did not prove it holds the owner token.')
      sendLine(stream, { t: 'admitted' })
      return 'done'
    })
  } catch (error) {
    stream.destroy()
    throw error
  }
  return { purpose: purpose as unknown as FrontDoorPurpose, via }
}

/**
 * The front door's half: prove the server first, then itself. Resolves with
 * the stream ready for the purpose's own protocol. Rejects, having sent no
 * secret and nothing derived from one, when the other end is not the server.
 */
export async function enterFrontDoor(
  stream: Duplex,
  options: { token: string; purpose: FrontDoorPurpose; timeoutMs?: number; nonce?: string },
): Promise<Duplex> {
  const tokenHash = ownerTokenHash(options.token)
  const nonce = options.nonce ?? freshNonce()
  let proven = false
  sendLine(stream, { t: 'front-door', v: FRONT_DOOR_PROOF_VERSION, purpose: options.purpose, nonce })
  try {
    await readPreamble(stream, options.timeoutMs ?? DEFAULT_FRONT_DOOR_TIMEOUT_MS, (message) => {
      if (!proven) {
        if (
          message.t !== 'challenge' ||
          !validNonce(message.serverNonce) ||
          !proofsMatch(serverProof(tokenHash, nonce, message.serverNonce, options.purpose), message.proof)
        )
          throw new FrontDoorRefusedError(
            'Whatever answered is not the Studio server this app started: it could not prove it holds the owner token.',
          )
        proven = true
        sendLine(stream, { t: 'prove', proof: clientProof(tokenHash, nonce, message.serverNonce, options.purpose) })
        return 'more'
      }
      if (message.t !== 'admitted') throw new FrontDoorRefusedError('The Studio server did not admit the front door.')
      return 'done'
    })
  } catch (error) {
    stream.destroy()
    throw error
  }
  return stream
}
