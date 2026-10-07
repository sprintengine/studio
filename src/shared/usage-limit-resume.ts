import type { UsageLimitProvider } from './usage-limits'

// A chat whose turn a usage limit stopped, and the turn Studio can send it once
// the limit lifts. Main keeps them (src/main/usage-limits/resume.ts), with the
// setting that schedules one for every such chat; the chat's composer tray
// draws its own (agentChat/usageLimitResume.tsx).

/** Which of the plan's limits ran out, as the notice names it; null when the source did not say. */
export type UsageLimitKind = 'session' | 'weekly' | null

/** A chat by its identity: the agent record it is, in the workspace that holds it. */
export type UsageLimitResumeChat = { workspaceId: string; agentId: string }

export type UsageLimitResumeNotice = UsageLimitResumeChat & {
  provider: UsageLimitProvider
  limit: UsageLimitKind
  /** When the limit lifts (epoch ms), or null when nothing said. */
  resetsAt: number | null
  /** When the turn was stopped. */
  hitAt: number
  /** When the continuation goes out (epoch ms), or null while none is scheduled. */
  resumeAt: number | null
}

export type UsageLimitResumeState = {
  /** Schedule the resume for every chat a usage limit stops. Off by default: a resume spends the person's plan. */
  autoResume: boolean
  notices: UsageLimitResumeNotice[]
}

/**
 * What a window asks of the resumes: schedule a chat's (Resume at reset),
 * cancel it but keep the notice, dismiss the notice with whatever it had
 * scheduled, or switch the setting.
 */
export type UsageLimitResumeUpdate =
  (UsageLimitResumeChat & { kind: 'schedule' | 'cancel' | 'dismiss' }) | { kind: 'auto'; enabled: boolean }

const HOUR_MS = 60 * 60 * 1000

/** A window's kind by its length, else by the id Claude gives it. */
export function usageLimitKindOf(windowId: string | null, durationMs?: number): UsageLimitKind {
  if (durationMs === 5 * HOUR_MS) return 'session'
  if (durationMs === 7 * 24 * HOUR_MS) return 'weekly'
  if (windowId === 'five_hour') return 'session'
  if (windowId?.startsWith('seven_day')) return 'weekly'
  return null
}
