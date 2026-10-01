import type { Terminal } from '@xterm/xterm'

// Registry of live xterm Terminal instances, keyed by session id. The two panels
// (TerminalView/PlainTerminalPanel) register on create and unregister on dispose
// so the diagnostics panel can read aggregate scrollback (line counts) — the
// memory behind "23 terminals × 25k scrollback" — which is otherwise invisible.

// xterm BufferLine packs 3 Uint32 per cell (content + fg + bg). Used only for a
// labelled rough estimate, never presented as exact.
export const ESTIMATED_BYTES_PER_CELL = 12

export type ScrollbackEntry = {
  sessionId: string
  lines: number
  cols: number
}

export type ScrollbackFootprint = {
  instanceCount: number
  totalLines: number
  estimatedBytes: number
  perSession: ScrollbackEntry[]
}

const instances = new Map<string, Terminal>()
const listeners = new Set<() => void>()

export function registerTerminalInstance(sessionId: string, term: Terminal): void {
  instances.set(sessionId, term)
  for (const listener of listeners) listener()
}

/** Whether a pane with a live xterm is mounted for this session in this window. */
export function hasTerminalInstance(sessionId: string): boolean {
  return instances.has(sessionId)
}

export function unregisterTerminalInstance(sessionId: string): void {
  if (instances.delete(sessionId)) {
    for (const listener of listeners) listener()
  }
}

// Pure: turns per-terminal line/col readings into totals + a rough memory
// estimate. Separated from the live registry read so it is unit-testable.
export function computeScrollbackFootprint(entries: readonly ScrollbackEntry[]): ScrollbackFootprint {
  let totalLines = 0
  let estimatedBytes = 0
  for (const entry of entries) {
    totalLines += entry.lines
    estimatedBytes += entry.lines * entry.cols * ESTIMATED_BYTES_PER_CELL
  }
  const perSession = [...entries].sort((a, b) => b.lines - a.lines)
  return { instanceCount: entries.length, totalLines, estimatedBytes, perSession }
}

// Browser-only: reads each live terminal's active buffer length. Guards every
// access so a partially-initialized terminal can't throw.
export function collectScrollbackFootprint(): ScrollbackFootprint {
  const entries: ScrollbackEntry[] = []
  for (const [sessionId, term] of instances) {
    let lines = 0
    let cols = 0
    try {
      lines = term.buffer?.active?.length ?? 0
      cols = term.cols ?? 0
    } catch {
      // Skip a terminal whose buffer isn't readable yet.
      continue
    }
    entries.push({ sessionId, lines, cols })
  }
  return computeScrollbackFootprint(entries)
}
