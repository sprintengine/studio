import { isRecord } from '../../shared/records'
import {
  claudeUsageWindowDurationMs,
  claudeUsageWindowLabel,
  isClaudeUsageWindowId,
  usageEpochMs,
  usagePercent,
  usageWindowLabelForMinutes,
  type UsageLimitStatus,
} from '../../shared/usage-limits'
import type { UsageWindowUpdate } from './store'

// What each agent reports about its usage limits, read into window updates.
// Structural on purpose, like the adapters these are called from: the SDK's
// and the app-server's shapes move between releases, and an unknown shape is
// dropped rather than guessed at.

// --- Claude ------------------------------------------------------------------

/**
 * Billing from the credential source a Claude Code session's init names
 * (normalized by `normalizeApiKeySource`). `none` is a claude.ai login — the
 * login this app's Claude chats run on; the three key sources bill the API.
 * The legacy members say nothing either way.
 */
export function claudeBillingOf(apiKeySource: string | null): 'subscription' | 'api' | null {
  if (apiKeySource === 'none') return 'subscription'
  if (apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper' || apiKeySource === '/login managed key')
    return 'api'
  return null
}

export type ClaudeRateLimitReading = {
  /** The window this event moved, or null when it named none (a bare status). */
  update: UsageWindowUpdate | null
  /** Set when the event says requests are being refused now. */
  rejected: { windowId: string | null; resetsAt: number | null } | null
  /** The event says requests go through again. */
  allowed: boolean
}

/**
 * One `rate_limit_event`'s `rate_limit_info` (the SDK's `SDKRateLimitInfo`).
 * Its `utilization` is a fraction of the window, 0..1, as the CLI's own
 * display multiplies it; `resetsAt` is epoch seconds. A window that is full
 * while the person's extra usage carries them is a warning, not a refusal:
 * their turns still run.
 */
export function readClaudeRateLimitInfo(raw: unknown): ClaudeRateLimitReading | null {
  if (!isRecord(raw)) return null
  const status = raw.status
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return null
  const resetsAt = usageEpochMs(raw.resetsAt)
  const type = typeof raw.rateLimitType === 'string' ? raw.rateLimitType : null
  const windowId = type && isClaudeUsageWindowId(type) ? type : null
  const carriedByOverage =
    status === 'rejected' &&
    (raw.isUsingOverage === true || raw.overageStatus === 'allowed' || raw.overageStatus === 'allowed_warning')
  const refused = status === 'rejected' && !carriedByOverage
  const windowStatus: UsageLimitStatus = refused ? 'rejected' : status === 'allowed' ? 'allowed' : 'warning'
  const fraction = typeof raw.utilization === 'number' ? usagePercent(raw.utilization * 100) : null
  const update: UsageWindowUpdate | null = windowId
    ? {
        id: windowId,
        label: claudeUsageWindowLabel(windowId),
        ...(fraction !== null ? { usedPercent: fraction } : {}),
        ...(resetsAt !== null ? { resetsAt } : {}),
        ...(claudeUsageWindowDurationMs(windowId) ? { durationMs: claudeUsageWindowDurationMs(windowId) } : {}),
        status: windowStatus,
      }
    : null
  return {
    update,
    rejected: refused ? { windowId, resetsAt } : null,
    allowed: status !== 'rejected',
  }
}

/** One window from a Claude Code status line, as the forwarder carries it: 0..100, reset in epoch ms. */
export type StatusLineRateLimit = { usedPercentage: number; resetsAt?: number }

/** The status line's `rate_limits`, as window updates. It says how full, never whether refused. */
export function claudeStatusLineUpdates(
  rateLimits: Readonly<Record<string, StatusLineRateLimit>>,
): UsageWindowUpdate[] {
  const updates: UsageWindowUpdate[] = []
  for (const [id, reading] of Object.entries(rateLimits)) {
    if (!isClaudeUsageWindowId(id)) continue
    const usedPercent = usagePercent(reading.usedPercentage)
    if (usedPercent === null) continue
    const resetsAt = usageEpochMs(reading.resetsAt)
    updates.push({
      id,
      label: claudeUsageWindowLabel(id),
      usedPercent,
      ...(resetsAt !== null ? { resetsAt } : {}),
      ...(claudeUsageWindowDurationMs(id) ? { durationMs: claudeUsageWindowDurationMs(id) } : {}),
    })
  }
  return updates
}

// The opening words of the message a Claude turn ends with when a usage limit
// refused it ("You've hit your limit · resets 3pm"). The SDK lists these, but
// as an alpha export; the two that mean a plan window ran out are kept here.
const CLAUDE_USAGE_LIMIT_PREFIXES = ["You've hit your", "You've reached your"]

export function isClaudeUsageLimitMessage(text: string): boolean {
  const trimmed = text.trimStart()
  return CLAUDE_USAGE_LIMIT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

// --- Codex -------------------------------------------------------------------

/**
 * Billing from `account/read` (the app-server's `GetAccountResponse`): a
 * ChatGPT sign-in has plan limits, an API key and a cloud provider's
 * credentials do not. No account says nothing.
 */
export function codexBillingOf(result: unknown): { billing: 'subscription' | 'api'; plan?: string } | null {
  const account = isRecord(result) && isRecord(result.account) ? result.account : null
  if (!account) return null
  if (account.type === 'chatgpt') {
    const plan = typeof account.planType === 'string' && account.planType !== 'unknown' ? account.planType : undefined
    return { billing: 'subscription', ...(plan ? { plan } : {}) }
  }
  if (account.type === 'apiKey' || account.type === 'amazonBedrock') return { billing: 'api' }
  return null
}

// The bucket every Codex account meters by default; any other is named.
const CODEX_DEFAULT_LIMIT_ID = 'codex'

/**
 * Windows from an `account/rateLimits/read` answer (`GetAccountRateLimitsResponse`)
 * or the `rateLimits` of an `account/rateLimits/updated` push (a sparse
 * `RateLimitSnapshot`). Each bucket has a primary (the short window) and a
 * secondary (the weekly one); `usedPercent` is 0..100 and `resetsAt` epoch
 * seconds. A window the push leaves null is left as it was.
 */
export function codexRateLimitUpdates(raw: unknown): UsageWindowUpdate[] {
  if (!isRecord(raw)) return []
  const buckets: Record<string, unknown>[] = []
  if (isRecord(raw.rateLimitsByLimitId)) {
    for (const bucket of Object.values(raw.rateLimitsByLimitId)) if (isRecord(bucket)) buckets.push(bucket)
  }
  // The single-bucket view mirrors one of the buckets above; read it only
  // when there are none, or it would be counted twice.
  if (buckets.length === 0) {
    if (isRecord(raw.rateLimits)) buckets.push(raw.rateLimits)
    else if ('primary' in raw || 'secondary' in raw) buckets.push(raw)
  }
  return buckets.flatMap(codexBucketUpdates)
}

function codexBucketUpdates(bucket: Record<string, unknown>): UsageWindowUpdate[] {
  const limitId = typeof bucket.limitId === 'string' && bucket.limitId ? bucket.limitId : CODEX_DEFAULT_LIMIT_ID
  const name =
    limitId === CODEX_DEFAULT_LIMIT_ID ? null : typeof bucket.limitName === 'string' ? bucket.limitName : limitId
  const updates: UsageWindowUpdate[] = []
  for (const slot of ['primary', 'secondary'] as const) {
    const window = bucket[slot]
    if (!isRecord(window)) continue
    const usedPercent = usagePercent(window.usedPercent)
    if (usedPercent === null) continue
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null
    const resetsAt = usageEpochMs(window.resetsAt)
    const label = usageWindowLabelForMinutes(minutes)
    updates.push({
      id: `${limitId}:${slot}`,
      label: name ? `${name} · ${label}` : label,
      usedPercent,
      ...(resetsAt !== null ? { resetsAt } : {}),
      ...(minutes && minutes > 0 ? { durationMs: minutes * 60_000 } : {}),
      // Codex says which bucket refused, not which window: the full one did.
      status: usedPercent >= 100 ? 'rejected' : 'allowed',
    })
  }
  return updates
}

/** A Codex turn error (`TurnError`) that is a plan's usage limit, not a transient rate limit. */
export function isCodexUsageLimitError(error: unknown): boolean {
  return isRecord(error) && error.codexErrorInfo === 'usageLimitExceeded'
}
