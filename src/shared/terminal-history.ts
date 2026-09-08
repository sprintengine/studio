export type TerminalHistoryTier = 'standard' | 'recent'

export type TerminalHistoryActivity = {
  startedAt?: number | null
  lastOutputAt?: number | null
  lastInputAt?: number | null
}

export const TERMINAL_RECENT_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
const TERMINAL_STANDARD_SCROLLBACK_LINES = 5_000
export const TERMINAL_RECENT_SCROLLBACK_LINES = TERMINAL_STANDARD_SCROLLBACK_LINES * 5
export const TERMINAL_STANDARD_REPLAY_BYTES = 512 * 1024
export const TERMINAL_RECENT_REPLAY_BYTES = TERMINAL_STANDARD_REPLAY_BYTES * 5

function getTerminalLastActivityAt(activity: TerminalHistoryActivity): number | null {
  const candidates = [
    activity.startedAt,
    activity.lastOutputAt,
    activity.lastInputAt,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

  if (candidates.length === 0) return null
  return Math.max(...candidates)
}

export function getTerminalHistoryTier(activity: TerminalHistoryActivity, now = Date.now()): TerminalHistoryTier {
  const lastActivityAt = getTerminalLastActivityAt(activity)
  if (lastActivityAt === null) return 'recent'
  return now - lastActivityAt <= TERMINAL_RECENT_HISTORY_WINDOW_MS ? 'recent' : 'standard'
}

export function getTerminalReplayLimitBytes(activity: TerminalHistoryActivity, now = Date.now()): number {
  return getTerminalHistoryTier(activity, now) === 'recent'
    ? TERMINAL_RECENT_REPLAY_BYTES
    : TERMINAL_STANDARD_REPLAY_BYTES
}
