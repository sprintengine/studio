import type { TerminalSessionSnapshot } from '../shared/electron-api'

// The port a remote transport uses to watch and drive a terminal.
//
// Kept in its own module, free of Electron and node-pty, so the tailnet
// listener can depend on the CONTRACT without pulling the terminal runtime (and
// its native pty binding) into a transport test. The runtime implements it; the
// tailnet WebSocket at /tailnet/v1/terminal is its first caller.

/**
 * What an attached viewer may do.
 *
 * `observe` is stream-only: input and resize are refused at the frame, never
 * quietly ignored. `control` is arbitrary shell on the host, which is why the
 * pairing scopes keep it a separate grant (see src/shared/tailnet.ts).
 */
export type TerminalAttachScope = 'observe' | 'control'

export type TerminalAttachFrame =
  /**
   * The retained scrollback. `attach` is the join-mid-session snapshot (the
   * same replay-then-live path a hidden pane's reveal uses); `resync` is the
   * recovery after this viewer fell too far behind and its queued bytes were
   * dropped — the replay is a superset of what was dropped, so it repaints
   * rather than leaving a hole.
   */
  | { type: 'replay'; data: string; reason: 'attach' | 'resync' }
  | { type: 'output'; data: string }
  /** The pty exited on its own. The session stays, painted, until it is closed. */
  | { type: 'exit'; exitCode: number }
  /** The session went away (closed, or paused to reclaim memory). Nothing more will arrive. */
  | { type: 'ended'; reason: string }

export type TerminalAttachTransport = {
  /** Unique per attached socket; the runtime keys this viewer's buffer by it. */
  viewerId: string
  send(frame: TerminalAttachFrame): void
  isOpen(): boolean
  /** Bytes accepted by the transport but not yet on the wire — the backpressure probe. */
  queuedBytes(): number
}

type TerminalRemoteOutcome = { ok: true } | { ok: false; code: string; message: string }

export type TerminalAttachment = {
  sessionId: string
  scope: TerminalAttachScope
  /** The session as it was at attach, so a client can label the stream immediately. */
  session: TerminalSessionSnapshot
  write(data: string): TerminalRemoteOutcome
  resize(cols: number, rows: number): TerminalRemoteOutcome
  detach(): void
}

export type TerminalAttachResult =
  { ok: true; attachment: TerminalAttachment } | { ok: false; code: string; message: string }

export type TerminalRemoteHost = {
  listSessions(): TerminalSessionSnapshot[]
  attach(input: {
    sessionId: string
    scope: TerminalAttachScope
    transport: TerminalAttachTransport
  }): TerminalAttachResult
}

/**
 * How far a remote viewer's transport may fall behind before its output is
 * dropped in favour of a later replay.
 *
 * The pty never waits on a socket: a consumer on a slow link that cannot drain
 * loses bytes and is repainted from the retained scrollback, because the
 * alternative — queueing without bound — grows main's heap until the app dies,
 * and the alternative to THAT — waiting — stalls the pty and the local window
 * behind a stranger's link.
 */
export const TERMINAL_REMOTE_TRANSPORT_HIGH_WATER_BYTES = 512 * 1024

/** Bytes buffered for one remote viewer before the oldest are dropped and it resyncs. */
export const TERMINAL_REMOTE_PENDING_LIMIT_BYTES = 256 * 1024

/**
 * The most text one remote frame carries, in UTF-16 units.
 *
 * Every WebSocket decoder on this transport — the Studio client, the phone —
 * refuses a frame over 1 MB, and a session touched in the last day retains up
 * to 2.5 MB of replay. Sent whole, an attach or a resync of such a session
 * was refused by the client, which closed the socket, re-dialled, was sent
 * the same replay, and refused it again: a reconnect loop that re-encoded
 * megabytes on the host every backoff step. 128K characters is the largest
 * slice whose JSON encoding stays under the cap even when every character is
 * an escaped control byte (six bytes each).
 */
export const TERMINAL_REMOTE_FRAME_CHUNK_CHARS = 128 * 1024

/**
 * One frame as the frames the wire may carry.
 *
 * A replay or output larger than the chunk becomes a first frame of the same
 * type followed by `output` frames — never several `replay` frames, because a
 * client paints a replay by clearing first, and a second one would erase the
 * first. Any client that understands replay-then-output already understands
 * this, so an older phone needs no change. A surrogate pair is never split
 * across a boundary.
 */
export function splitTerminalAttachFrame(frame: TerminalAttachFrame): TerminalAttachFrame[] {
  if (frame.type !== 'replay' && frame.type !== 'output') return [frame]
  const { data } = frame
  if (data.length <= TERMINAL_REMOTE_FRAME_CHUNK_CHARS) return [frame]
  const parts: TerminalAttachFrame[] = []
  let offset = 0
  while (offset < data.length) {
    let end = Math.min(offset + TERMINAL_REMOTE_FRAME_CHUNK_CHARS, data.length)
    if (end < data.length) {
      const last = data.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    const piece = data.slice(offset, end)
    parts.push(
      parts.length === 0 && frame.type === 'replay'
        ? { type: 'replay', data: piece, reason: frame.reason }
        : { type: 'output', data: piece },
    )
    offset = end
  }
  return parts
}
