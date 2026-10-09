// What a turn spent, as `turn_completed` reports it (`ConversationTurnUsage`):
// fresh input, output, and the prompt cache's reads and writes, each a count of
// tokens summed over the turn's model requests. Each provider reads its CLI's
// own numbers into this shape; these are the two steps they share.

import type { ConversationTurnUsage } from '../conversation-runtime'

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

/**
 * A usage from counts that may or may not be there: a count that is not a
 * non-negative number is left out rather than read as zero. Null when none is.
 */
export function turnUsageOf(counts: {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}): ConversationTurnUsage | null {
  const usage: ConversationTurnUsage = {}
  for (const key of USAGE_KEYS) {
    const value = count(counts[key])
    if (value !== undefined) usage[key] = value
  }
  return Object.keys(usage).length > 0 ? usage : null
}

/** Two usages added up, member by member; a member either one reports is in the sum. */
export function addTurnUsage(
  total: ConversationTurnUsage | null | undefined,
  next: ConversationTurnUsage | null | undefined,
): ConversationTurnUsage | null {
  if (!total) return next ? { ...next } : null
  if (!next) return { ...total }
  const sum: ConversationTurnUsage = { ...total }
  for (const key of USAGE_KEYS) {
    if (next[key] === undefined) continue
    sum[key] = (sum[key] ?? 0) + next[key]
  }
  return sum
}
