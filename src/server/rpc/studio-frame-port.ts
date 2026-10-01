import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Duplex } from 'node:stream'

import { STUDIO_SCOPES, type StudioGrant } from '../../../packages/studio-protocol/src/public'
import type { StudioAuthenticator } from './studio-rpc-types'

// A Studio connection over a message port: one frame per message instead of
// one per line. It is how Studio's own windows reach the RPC. Main makes a
// channel per connection, keeps one end and hands the other to the window's
// preload, which keeps it out of the page; once the server runs in a process
// of its own, main hands its end to that process instead, and nothing on the
// window's side changes.
//
// The port is the window's identity: main gives one only to a window of its
// own (the same check its IPC makes). The hello on it still carries a
// credential, as every hello does, but one that cannot be used anywhere else:
// a ticket minted for this connection alone, good for one hello within
// thirty seconds. The window never holds anything longer-lived.

/** The end of a message channel a Studio connection runs over. Main's `MessagePortMain` is one. */
export type StudioFramePort = {
  /** Send one frame, already encoded as JSON. */
  post(frame: string): void
  onFrame(listener: (frame: string) => void): void
  /** Fires once, when the other end is gone. */
  onClose(listener: () => void): void
  close(): void
}

/**
 * The port as the stream a connection reads and writes: each message in is
 * one line, and each line written goes out as one message. A port does not
 * push back, so a write never waits; the window reads its frames as fast as
 * IPC would hand them over.
 */
export function framePortStream(port: StudioFramePort): Duplex {
  let pending = ''
  let ended = false
  const stream = new Duplex({
    read() {
      // Frames are pushed as they arrive.
    },
    write(chunk: Buffer | string, _encoding, callback) {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let newline = pending.indexOf('\n')
      try {
        while (newline !== -1) {
          const frame = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (frame) port.post(frame)
          newline = pending.indexOf('\n')
        }
        callback()
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
    final(callback) {
      // The last frames written (a `bye`) are on their way; the close follows
      // them on the next turn rather than racing them out of the same one.
      setImmediate(finish)
      callback()
    },
    destroy(error, callback) {
      finish()
      callback(error)
    },
  })
  function finish(): void {
    if (ended) return
    ended = true
    try {
      port.close()
    } catch {
      // Already closed.
    }
  }
  port.onFrame((frame) => {
    if (!ended) stream.push(`${frame}\n`)
  })
  port.onClose(() => {
    if (ended) return
    ended = true
    stream.push(null)
    stream.destroy()
  })
  return stream
}

const TICKET_TTL_MS = 30_000

/** A ticket: printable, unguessable, and shaped as a hello's credential must be. */
export function mintStudioTicket(): string {
  return `seport_${randomBytes(24).toString('base64url')}`
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The grant a Studio window holds: the owner's, under a name the audit and diagnostics can tell apart. */
export function studioWindowGrant(): StudioGrant {
  return { clientId: 'owner', name: 'Studio window', owner: true, scopes: [...STUDIO_SCOPES], ceiling: 'bypass' }
}

/**
 * Who may say hello on one window's connection: whoever presents its ticket,
 * once, within thirty seconds of its minting. What it is granted is the
 * owner's, since the window is Studio's own.
 */
export function createTicketAuthenticator(
  ticket: string,
  options: { now?: () => number; grant?: () => StudioGrant } = {},
): StudioAuthenticator {
  const now = options.now ?? Date.now
  const grant = options.grant ?? studioWindowGrant
  const minted = now()
  let spent = false
  return {
    authenticate(auth) {
      if (spent || !('token' in auth) || now() - minted > TICKET_TTL_MS || !sameSecret(auth.token, ticket))
        return { ok: false, message: 'This window’s connection ticket is spent, expired or wrong. Reconnect.' }
      spent = true
      return { ok: true, grant: grant() }
    },
    grantFor: (clientId) => (spent && clientId === grant().clientId ? grant() : null),
    onRevoked: () => () => undefined,
    onGrantChanged: () => () => undefined,
  }
}
