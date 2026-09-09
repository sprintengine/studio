import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'

import {
  TERMINAL_CELL_GEOMETRY_OPTIONS,
  TERMINAL_UNICODE_VERSION,
} from '../shared/terminal-options'

// Blank-screen fix for suspended agent terminals.
//
// Agent CLIs (Claude, Codex) paint full-screen TUIs on the terminal ALTERNATE
// screen buffer. When we suspend a terminal we kill its process to reclaim RAM,
// but the only thing we retain is the raw PTY byte stream (`outputChunks`).
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
  const scaled = SNAPSHOT_RENDER_BASE_TIMEOUT_MS
    + (dataLength / 1_048_576) * SNAPSHOT_RENDER_TIMEOUT_PER_MB_MS
  return Math.min(SNAPSHOT_RENDER_MAX_TIMEOUT_MS, Math.round(scaled))
}

export async function buildReplaySnapshot(
  data: string,
  cols: number,
  rows: number
): Promise<string | null> {
  if (!data) return null
  const safeCols = Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20)
  const safeRows = Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8)
  try {
    return await renderAndSerialize(data, safeCols, safeRows)
  } catch {
    // Headless render / serialize failed — let the caller use the raw replay.
    return null
  }
}

function renderAndSerialize(data: string, cols: number, rows: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
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
    const timeout = setTimeout(() => finish(null), snapshotRenderTimeoutMs(data.length))
    timeout.unref?.()

    term.write(data, () => {
      clearTimeout(timeout)
      try {
        const serialized = serializer.serialize()
        finish(serialized && serialized.length > 0 ? serialized : null)
      } catch {
        finish(null)
      }
    })
  })
}
