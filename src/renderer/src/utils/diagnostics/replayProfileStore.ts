import type { XtermReplayProfile } from '../xtermOutputQueue'

// In-memory ring buffer of recent terminal-replay profiles. Populated at the
// two TerminalView/PlainTerminalPanel callsites that already log
// `terminal-replay-profile`, and read by the diagnostics panel. Renderer-local
// (no IPC): replay timing is a renderer concern and the panel runs in the same
// process. Bounded so a long session cannot grow this without limit.
const REPLAY_PROFILE_HISTORY_LIMIT = 100

export type ReplayProfileEntry = XtermReplayProfile & {
  recordedAt: number
  sessionId: string
  workspaceId?: string
  agentId?: string
  terminalId?: string
  kind: 'agent' | 'terminal'
}

const entries: ReplayProfileEntry[] = []
const listeners = new Set<() => void>()

export function recordReplayProfile(entry: ReplayProfileEntry): void {
  entries.push(entry)
  if (entries.length > REPLAY_PROFILE_HISTORY_LIMIT) {
    entries.splice(0, entries.length - REPLAY_PROFILE_HISTORY_LIMIT)
  }
  for (const listener of listeners) listener()
}

// Most-recent-first copy, so the panel can render newest profiles at the top
// without mutating the buffer.
export function getReplayProfiles(): ReplayProfileEntry[] {
  return [...entries].reverse()
}

export function subscribeReplayProfiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
