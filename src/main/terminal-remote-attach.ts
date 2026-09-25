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

/**
 * Where a remote viewer stands in a session's output: a byte offset into the
 * session's UTF-8 output stream, and the stream it counts in.
 *
 * Byte offsets rather than a chunk counter because the host already keeps them
 * (the retained window is addressed by them, see terminal-replay-buffer), and
 * because a byte offset names a point INSIDE a frame too — a client sent a
 * frame that overlaps what it already has can keep only the new part.
 * `stream` changes when the offsets stop meaning the same bytes: a session
 * restored after a restart, or one whose stream was released behind a
 * snapshot.
 */
export type TerminalStreamPosition = { stream: string; position: number }

export type TerminalAttachFrame =
  /**
   * The retained scrollback. `attach` is the join-mid-session snapshot (the
   * same replay-then-live path a hidden pane's reveal uses); `resync` is the
   * recovery after what this viewer missed was no longer retained — the replay
   * is a superset of it, so it repaints rather than leaving a hole.
   *
   * `stream` and `position` (the offset the replay covers up to) are absent
   * from a host that predates resuming. A replay sent in slices carries
   * `stream` on this frame and `position` on its LAST slice, since only once
   * that has arrived does the client hold everything up to it.
   */
  | { type: 'replay'; data: string; reason: 'attach' | 'resync'; stream?: string; position?: number }
  /**
   * The answer to an attach that asked to resume: the host still holds
   * everything after `position`, so the client keeps its screen and the
   * missing tail follows as ordinary `output`. Only ever sent to a client that
   * asked, so a client that never resumes never sees it.
   */
  | { type: 'resumed'; stream: string; position: number }
  /**
   * Live output. `position` is the stream offset just past `data`: a client
   * that already holds up to it drops the frame, and one that holds part of it
   * keeps the rest. Absent on a replay's middle slices and from a host that
   * predates resuming.
   */
  | { type: 'output'; data: string; position?: number }
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
    /**
     * Where the client's screen already stands, from an earlier attach to the
     * same session. When the host still retains everything after it, the
     * client is sent only that tail; otherwise, or when absent, a full replay.
     */
    resume?: TerminalStreamPosition
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

/**
 * How far a viewer that fell behind must drain before it is caught up.
 *
 * Well under the high water, so a link hovering around the bound does not
 * alternate between withheld and caught up on every batch: each catch-up is
 * one frame of everything since, and a flapping viewer would be sent many
 * small ones instead of one worth sending.
 */
export const TERMINAL_REMOTE_TRANSPORT_LOW_WATER_BYTES = 128 * 1024

/**
 * The most a catch-up may carry before a full replay is sent instead.
 *
 * A catch-up is appended to what the client already shows, so every byte of it
 * is parsed on the far side; past this, the retained window's replay — which
 * starts from a clean head and is not much larger — is the better repaint.
 * Sized so a laptop that slept through a few minutes of an agent's output
 * resumes by appending, and one that slept through an hour of a build log is
 * repainted.
 */
export const TERMINAL_REMOTE_CATCH_UP_BUDGET_BYTES = 2 * 1024 * 1024

/** Bytes buffered for one remote viewer before the oldest are dropped and it is caught up. */
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
 * across a boundary, so every slice ends on a code point and its position is a
 * point a client may resume from.
 *
 * Positions follow the slices. A sliced `output` is byte-exact stream text, so
 * each slice carries the offset just past it. A sliced `replay` is not (its
 * head may have been trimmed to a clean escape boundary), so only its last
 * slice carries the position and the slices before it none: a client holds the
 * replay's position only once the whole replay has arrived.
 */
export function splitTerminalAttachFrame(frame: TerminalAttachFrame): TerminalAttachFrame[] {
  if (frame.type !== 'replay' && frame.type !== 'output') return [frame]
  const { data } = frame
  if (data.length <= TERMINAL_REMOTE_FRAME_CHUNK_CHARS) return [frame]
  const pieces: string[] = []
  let offset = 0
  while (offset < data.length) {
    let end = Math.min(offset + TERMINAL_REMOTE_FRAME_CHUNK_CHARS, data.length)
    if (end < data.length) {
      const last = data.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    pieces.push(data.slice(offset, end))
    offset = end
  }
  const { position } = frame
  if (frame.type === 'replay') {
    const last = pieces.length - 1
    return pieces.map((piece, index): TerminalAttachFrame => {
      if (index === 0) {
        return {
          type: 'replay',
          data: piece,
          reason: frame.reason,
          ...(frame.stream !== undefined ? { stream: frame.stream } : {}),
        }
      }
      return index === last && position !== undefined
        ? { type: 'output', data: piece, position }
        : { type: 'output', data: piece }
    })
  }
  if (position === undefined) return pieces.map((piece): TerminalAttachFrame => ({ type: 'output', data: piece }))
  let cursor = position - Buffer.byteLength(data, 'utf8')
  return pieces.map((piece): TerminalAttachFrame => {
    cursor += Buffer.byteLength(piece, 'utf8')
    return { type: 'output', data: piece, position: cursor }
  })
}
