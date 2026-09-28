// A session's prompt cache as the surfaces read it: warm, about to go cold, or
// cold — and what that means for the next message. Derived from the session's
// reading (shared/prompt-cache.ts) and a clock, never stored, so a session
// whose process went quiet still goes cold on time.

import { formatRelativeMs } from '../../utils/relativeTime'
import { formatTokenCount } from '../panels/agentChat/turnMeta'
import type { PromptCacheReading, PromptCacheTtl } from '../../../../shared/prompt-cache'

export type PromptCacheState =
  | { kind: 'warm'; remainingMs: number; recacheTokens: number | null }
  | { kind: 'expiring'; remainingMs: number; recacheTokens: number | null }
  | { kind: 'cold'; expiredAt: number | null; recacheTokens: number | null }

// How long before it goes cold a cache counts as expiring: long enough to act
// on. A five-minute cache is expiring for most of its life, so it is only
// called out in its last two minutes; an hour's cache gets ten.
const EXPIRING_WITHIN_MS: Readonly<Record<PromptCacheTtl, number>> = {
  '5m': 2 * 60_000,
  '1h': 10 * 60_000,
}

/**
 * Below this, re-caching a conversation is cheap enough not to mention. The
 * point of the marks is the session a cold resume would cost hundreds of
 * thousands of tokens, not every short chat in the sidebar.
 */
export const PROMPT_CACHE_NOTICE_TOKENS = 50_000

export function promptCacheState(reading: PromptCacheReading | null | undefined, now: number): PromptCacheState | null {
  if (!reading) return null
  const { expiresAt, recacheTokens } = reading
  if (expiresAt !== null && expiresAt > now) {
    const remainingMs = expiresAt - now
    const window = EXPIRING_WITHIN_MS[reading.ttl ?? '1h']
    return { kind: remainingMs <= window ? 'expiring' : 'warm', remainingMs, recacheTokens }
  }
  return { kind: 'cold', expiredAt: expiresAt, recacheTokens }
}

/**
 * Whether the cache is worth a mark: it is going or gone, and the conversation
 * is big enough that re-caching it matters. A size the source has not reported
 * yet (right after a compaction) is not assumed big.
 */
export function promptCacheNeedsAttention(
  state: PromptCacheState | null,
): state is Exclude<PromptCacheState, { kind: 'warm' }> {
  return state !== null && state.kind !== 'warm' && (state.recacheTokens ?? 0) >= PROMPT_CACHE_NOTICE_TOKENS
}

// "8m", or "under a minute" where the short form has nothing to say.
function span(ms: number): string {
  return formatRelativeMs(0, ms) || 'under a minute'
}

/**
 * The words for a cache state: a short `label` for a tooltip's first line or a
 * card's status, and a `detail` sentence saying what it means for the next
 * message and what compacting buys.
 */
export function promptCacheCopy(state: PromptCacheState, now: number): { label: string; detail: string } {
  const tokens =
    state.recacheTokens !== null ? `~${formatTokenCount(state.recacheTokens)} tokens` : 'the whole conversation'
  if (state.kind === 'warm') {
    return {
      label: `Cache warm · ${span(state.remainingMs)} left`,
      detail: `The next message re-reads the conversation from the prompt cache for ${span(state.remainingMs)} more.`,
    }
  }
  if (state.kind === 'expiring') {
    return {
      label: `Cache expires in ${span(state.remainingMs)}`,
      detail: `After that, the next message re-sends ${tokens} uncached. Compacting now, while the cache is warm, is cheap.`,
    }
  }
  const ago = state.expiredAt !== null ? formatRelativeMs(state.expiredAt, now) : ''
  return {
    label: ago ? `Cache expired ${ago} ago` : 'Cache cold',
    // Compacting a cold cache re-reads the conversation uncached too; what it
    // buys is every message after it.
    detail: `The next message re-sends ${tokens} uncached, a compaction included. Compacting first makes every message after it smaller.`,
  }
}
