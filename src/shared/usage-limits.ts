// A subscription's usage limits — the five-hour session window and the weekly
// ones — as the agent CLIs report them to us. Main keeps the latest reading per
// provider (src/main/usage-limits) and the renderer draws it; both read the
// shapes and the arithmetic here.
//
// Every number comes from something an agent already hands the app: the Claude
// Agent SDK's `rate_limit_event`, the `rate_limits` block of Claude Code's
// status-line payload, and the Codex app-server's `account/rateLimits/*`. The
// app never asks a provider for them itself and never reads a credential to.

export type UsageLimitProvider = 'claude' | 'codex'

export const USAGE_LIMIT_PROVIDERS: readonly UsageLimitProvider[] = ['claude', 'codex']

/**
 * How the account pays. Limits exist only on a subscription: a provider whose
 * latest session billed an API key shows nothing, and one nothing has said
 * anything about yet shows nothing either, rather than a guess.
 */
export type UsageLimitBilling = 'subscription' | 'api' | 'unknown'

/** The provider's own word for where a window stands; `rejected` is a limit reached. */
export type UsageLimitStatus = 'allowed' | 'warning' | 'rejected'

export type UsageLimitWindow = {
  /** Stable across sources and updates (`five_hour`, `seven_day`, `codex:primary`…): partial updates merge on it. */
  id: string
  label: string
  /** 0..100. Null when the source said where the window stands but not how full it is. */
  usedPercent: number | null
  /** Epoch ms the window resets, or null when not reported. */
  resetsAt: number | null
  /** How long the window is, for the pace marker; absent when unknown. */
  durationMs?: number
  status: UsageLimitStatus
  /** When this window was last reported (epoch ms). */
  observedAt: number
}

export type UsageLimitSnapshot = {
  provider: UsageLimitProvider
  billing: UsageLimitBilling
  /** The plan the provider named (`max`, `plus`…), when it did. */
  plan?: string
  windows: UsageLimitWindow[]
  /** The newest of the windows' readings (epoch ms). */
  observedAt: number
}

/** What main pushes to the renderer: one snapshot per provider that has something to show. */
export type UsageLimitsState = { snapshots: UsageLimitSnapshot[] }

/** A turn that ended because a usage limit was reached, for whatever waits to resume it. */
export type UsageLimitHit = {
  provider: UsageLimitProvider
  /** The conversation session whose turn failed. */
  sessionId: string
  /** When the limit lifts (epoch ms), or null when nothing said. */
  resetsAt: number | null
  /** The window that ran out, when the source named one. */
  windowId: string | null
  at: number
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** At or past this share used, a window reads as a warning. */
export const USAGE_LIMIT_WARN_PERCENT = 90

/** A reading older than this is drawn with "as of <time>". */
export const USAGE_LIMIT_STALE_AFTER_MS = 15 * 60 * 1000

// Claude's window kinds. The SDK's `rateLimitType` and the status line's keys
// share these names, so a window from either source merges into the same row.
const CLAUDE_WINDOWS: Record<string, { label: string; durationMs: number }> = {
  five_hour: { label: 'Session (5h)', durationMs: 5 * HOUR_MS },
  seven_day: { label: 'Weekly', durationMs: 7 * DAY_MS },
  seven_day_opus: { label: 'Weekly · Opus', durationMs: 7 * DAY_MS },
  seven_day_sonnet: { label: 'Weekly · Sonnet', durationMs: 7 * DAY_MS },
}

/** Whether `id` is a Claude window this app draws (the overage and credit kinds are not limits). */
export function isClaudeUsageWindowId(id: string): boolean {
  return Object.hasOwn(CLAUDE_WINDOWS, id)
}

export function claudeUsageWindowLabel(id: string): string {
  return CLAUDE_WINDOWS[id]?.label ?? id
}

export function claudeUsageWindowDurationMs(id: string): number | undefined {
  return CLAUDE_WINDOWS[id]?.durationMs
}

/** A window named by its length, as Codex reports it in minutes. */
export function usageWindowLabelForMinutes(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return 'Usage'
  if (minutes === 5 * 60) return 'Session (5h)'
  if (minutes === 7 * 24 * 60) return 'Weekly'
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/**
 * A reset time as epoch ms. The CLIs send epoch seconds, a status line or an
 * ISO string may arrive in another form, and anything that is not a real time
 * is no time at all.
 */
export function usageEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Ten digits of seconds reach the year 2286; anything larger is already ms.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

/** A share used, clamped into 0..100, or null when not a number. */
export function usagePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

/** The window has reset since it was read: its share is no longer true. */
export function usageWindowHasReset(window: Pick<UsageLimitWindow, 'resetsAt'>, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt <= now
}

/** The window is at its limit, or close enough to say so. A window that has reset is neither. */
export function usageWindowIsWarning(window: UsageLimitWindow, now: number): boolean {
  if (usageWindowHasReset(window, now)) return false
  return window.status === 'rejected' || (window.usedPercent ?? 0) >= USAGE_LIMIT_WARN_PERCENT
}

export type UsagePace = 'ahead' | 'on' | 'under'

/**
 * How the share used compares with the share of the window gone by: `ahead`
 * runs out before the reset at this rate, `under` has room to spare. Null when
 * the window's length, reset or share is unknown, or it has already reset.
 */
export function usageWindowPace(
  window: UsageLimitWindow,
  now: number,
): { pace: UsagePace; elapsedPercent: number } | null {
  if (window.usedPercent === null || window.resetsAt === null || !window.durationMs) return null
  if (usageWindowHasReset(window, now)) return null
  const remaining = window.resetsAt - now
  if (remaining > window.durationMs) return null
  const elapsedPercent = Math.min(100, Math.max(0, ((window.durationMs - remaining) / window.durationMs) * 100))
  // Ten points either way is "on pace": closer than that is noise in a share
  // reported to the whole percent.
  const delta = window.usedPercent - elapsedPercent
  return { pace: delta > 10 ? 'ahead' : delta < -10 ? 'under' : 'on', elapsedPercent }
}

/** "2h 13m", "3d 4h", "12m", "under a minute": the time until `at`. */
export function formatUsageResetIn(at: number, now: number): string {
  const ms = at - now
  if (ms < 60_000) return 'under a minute'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  const mins = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}

/** The provider's name as the popover heads its section. */
export function usageProviderLabel(provider: UsageLimitProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
}
