import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'

import { TERMINAL_CELL_GEOMETRY_OPTIONS, TERMINAL_UNICODE_VERSION } from '../shared/terminal-options'
import { resyncTerminalReplayHead } from './terminal-session'

// Blank-screen fix for suspended agent terminals.
//
// Agent CLIs (Claude, Codex) paint full-screen TUIs on the terminal ALTERNATE
// screen buffer. When we suspend a terminal we kill its process to reclaim RAM,
// but the only thing we retain is the raw PTY byte stream (`output`).
// Replaying that raw stream into a fresh xterm does NOT faithfully reconstruct
// the TUI: buffer compaction can drop the `DECSET 1049` "enter alt-screen"
// sequence, `term.reset()` clears alt-screen mode on re-reveal, and — because the
// process is dead — nothing repaints. The result is a blank or garbled screen.
//
// Instead we render the retained stream ONCE through a headless terminal (which
// correctly tracks alt-screen state, cursor moves, and clears) and serialize the
// resulting screen + scrollback. That serialized payload, written into a fresh
// xterm on reopen, reproduces the last painted screen with no live process. We do
// this at suspend time, off the retained buffer, so it costs nothing until a
// terminal is actually paused. Verified round-trip-faithful for alt-screen
// content in terminal-replay-snapshot.test.ts.
//
// Best-effort: any failure (or an empty render) returns null so the caller falls
// back to the existing raw-stream replay — this is strictly additive and can
// never make a suspended terminal worse than today's behavior.

// Bound how much scrollback the serialized snapshot carries. The snapshot's job
// is to repaint the last screen faithfully; deep scrollback is already covered by
// the raw replay if needed. Keeps the serialized payload small.
const SNAPSHOT_SCROLLBACK_ROWS = 1000

// Guard against a pathological stream hanging the (async, off-critical-path)
// suspend render — but scale with payload size: an agent TUI's retained stream
// can be several MB of repaint traffic, and a reap sweep may render several
// terminals concurrently on the same event loop. A flat 2s cap made big-but-
// healthy renders time out, which is how painted-pause degraded to a blank
// screen (no snapshot → raw alt-screen replay reconstructs nothing).
const SNAPSHOT_RENDER_BASE_TIMEOUT_MS = 5_000
const SNAPSHOT_RENDER_TIMEOUT_PER_MB_MS = 4_000
const SNAPSHOT_RENDER_MAX_TIMEOUT_MS = 30_000

function snapshotRenderTimeoutMs(dataLength: number): number {
  const scaled = SNAPSHOT_RENDER_BASE_TIMEOUT_MS + (dataLength / 1_048_576) * SNAPSHOT_RENDER_TIMEOUT_PER_MB_MS
  return Math.min(SNAPSHOT_RENDER_MAX_TIMEOUT_MS, Math.round(scaled))
}

/**
 * How much of the stream the first render reads: its newest 512K UTF-16 units.
 *
 * The render runs on the main thread (sliced by xterm's own write scheduler,
 * but main-thread CPU all the same), once per suspended terminal and again for
 * every quit-path sidecar a restart reopens, and the retained stream can be
 * 2.5 MB. What a paused pane shows is its last screen plus
 * SNAPSHOT_SCROLLBACK_ROWS of history above it, and the newest half megabyte
 * of an ordinary stream holds far more than that — so that is all the first
 * pass reads. See {@link buildReplaySnapshot} for the case where it does not.
 */
export const SNAPSHOT_RENDER_TAIL_UNITS = 512 * 1024

export async function buildReplaySnapshot(data: string, cols: number, rows: number): Promise<string | null> {
  if (!data) return null
  const safeCols = Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20)
  const safeRows = Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8)
  try {
    const tail = snapshotRenderTail(data)
    const first = await renderAndSerialize(tail.text, safeCols, safeRows)
    // A stream that repaints in place — a spinner, a status line redrawn a
    // hundred times a turn — can spend the whole tail on a handful of rows.
    // Rendering only the tail would then hand the paused pane less history than
    // the snapshot has room for, so read it all once more. The scrollback a
    // paused pane reopens on is never smaller than it was before the tail
    // existed; the common stream pays for one small render instead of a big one.
    if (tail.cut && first.historyShort) {
      return (await renderAndSerialize(data, safeCols, safeRows)).serialized
    }
    return first.serialized
  } catch {
    // Headless render / serialize failed — let the caller use the raw replay.
    return null
  }
}

// Alternate-screen switches (DECSET/DECRST 1049, 1047, 47).
const ALT_SCREEN_ENTER = ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h']
const ALT_SCREEN_EXIT = ['\x1b[?1049l', '\x1b[?1047l', '\x1b[?47l']

/**
 * The newest SNAPSHOT_RENDER_TAIL_UNITS of the stream, made safe to start
 * reading: resynced past any escape sequence the cut landed in, and — when the
 * stream is on the alternate screen but the switch that put it there fell
 * before the cut — re-entered into it, or a full-screen TUI would be painted
 * onto the normal buffer and serialized as scrollback.
 */
export function snapshotRenderTail(data: string): { text: string; cut: boolean } {
  if (data.length <= SNAPSHOT_RENDER_TAIL_UNITS) return { text: data, cut: false }
  let start = data.length - SNAPSHOT_RENDER_TAIL_UNITS
  // Never begin on the second half of a surrogate pair.
  const first = data.charCodeAt(start)
  if (first >= 0xdc00 && first <= 0xdfff) start += 1
  let text = resyncTerminalReplayHead(data.slice(start))
  const lastEnter = Math.max(...ALT_SCREEN_ENTER.map((sequence) => data.lastIndexOf(sequence)))
  const lastExit = Math.max(...ALT_SCREEN_EXIT.map((sequence) => data.lastIndexOf(sequence)))
  if (lastEnter > lastExit && lastEnter < start) {
    const sequence = ALT_SCREEN_ENTER.find((candidate) => data.startsWith(candidate, lastEnter)) ?? ALT_SCREEN_ENTER[0]
    text = `${sequence}${text}`
  }
  return { text, cut: true }
}

type RenderResult = {
  serialized: string | null
  // The render left the normal buffer active with less history than the
  // snapshot keeps. An alternate-screen TUI never counts: its screen is the
  // whole of what the pane shows, and the normal buffer under it is hidden.
  historyShort: boolean
}

function renderAndSerialize(data: string, cols: number, rows: number): Promise<RenderResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: RenderResult): void => {
      if (settled) return
      settled = true
      try {
        term.dispose()
      } catch {
        // ignore disposal races
      }
      resolve(value)
    }

    const term = new Terminal({
      // The same cell-geometry block the live panes are built with
      // (`createStudioTerminal.ts`). Shared rather than copied because a
      // divergence here reflows the replayed screen away from the one the user
      // was looking at, silently — see `shared/terminal-options.ts`.
      ...TERMINAL_CELL_GEOMETRY_OPTIONS,
      cols,
      rows,
      // Deliberately NOT the panes' scrollback: this snapshot exists to repaint
      // the last screen, and deep history is already covered by the raw replay.
      scrollback: SNAPSHOT_SCROLLBACK_ROWS,
    })
    // The panes' width table, applied before a byte is written. Under xterm's
    // default version 6 an emoji is one column; under 11 it is two, so a
    // snapshot rendered on the default table wraps an agent frame somewhere
    // else entirely and the replay looks like corruption. `allowProposedApi`
    // (which `terminal.unicode` requires) now comes from the shared block that
    // carries the version, so the two cannot be separated by accident.
    //
    // The addon is width tables and nothing else — no DOM — which is why it can
    // be loaded here as well as in the renderer, exactly like SerializeAddon.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = TERMINAL_UNICODE_VERSION

    const serializer = new SerializeAddon()
    term.loadAddon(serializer)

    // term.write parses asynchronously; the callback fires once the whole stream
    // has been applied to the buffer. Guard with a size-scaled timeout so a
    // pathological stream can never hang the suspend path, while a large-but-
    // healthy TUI buffer gets the time its render actually needs.
    const timeout = setTimeout(
      () => finish({ serialized: null, historyShort: false }),
      snapshotRenderTimeoutMs(data.length),
    )
    timeout.unref?.()

    term.write(data, () => {
      clearTimeout(timeout)
      try {
        const serialized = serializer.serialize()
        const historyShort =
          term.buffer.active.type === 'normal' && term.buffer.normal.length < rows + SNAPSHOT_SCROLLBACK_ROWS
        finish({ serialized: serialized && serialized.length > 0 ? serialized : null, historyShort })
      } catch {
        finish({ serialized: null, historyShort: false })
      }
    })
  })
}
