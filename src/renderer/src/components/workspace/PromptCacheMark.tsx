// The prompt cache on the surfaces that show an agent at rest: a mark on its
// tab and sidebar line when the cache is about to go cold or has.

import React, { useEffect, useState } from 'react'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { CompactGlyph } from '../panels/agentChat/toolRows/ToolKindGlyph'
import type { PromptCacheReading } from '../../../../shared/prompt-cache'
import { promptCacheCopy, promptCacheMarkClock, promptCacheNeedsAttention, promptCacheState } from './promptCacheState'

// A minute is the finest a cache's time left is ever said in.
const CLOCK_MS = 30_000

/**
 * The time a mark reads, kept current only while it can change what the mark
 * draws. Every sidebar chat line and agent tab carries a mark, and most of
 * them can never draw one (a small conversation, or a cold cache where cold is
 * not shown), so they hold still. A warm cache sleeps until it starts to
 * expire, on one timer; only a mark that is drawn follows the shared clock.
 */
function usePromptCacheMarkNow(
  reading: PromptCacheReading | null | undefined,
  working: boolean,
  includeCold: boolean,
): number {
  // The time is read at render; the shared clock and the wake timer below only
  // ask for renders. Which of them is needed depends on the time itself, and
  // the shared clock's last tick is stale by design while it is not needed.
  const now = Date.now()
  const clock = promptCacheMarkClock(reading, working, includeCold, now)
  useRelativeNow(CLOCK_MS, clock.kind === 'tick')
  const [, wake] = useState(0)
  const wakeAt = clock.kind === 'wake' ? clock.at : null
  useEffect(() => {
    if (wakeAt === null) return undefined
    const timer = setTimeout(() => wake(Date.now()), Math.max(0, wakeAt - Date.now()))
    return () => clearTimeout(timer)
  }, [wakeAt])
  return now
}

/**
 * The compact mark, in the tone of how soon it matters: warn ink while the
 * cache is about to go cold, quiet ink once it has. Nothing while the agent is
 * working (every request refreshes the cache), for a warm cache, or for a
 * conversation too small for re-caching it to matter.
 *
 * `includeCold` is off where a cold mark would be on every old chat in a list
 * (the sidebar): there only the cache about to go is worth interrupting for.
 */
export function PromptCacheMark({
  reading,
  working,
  includeCold = true,
  className,
}: {
  reading: PromptCacheReading | null | undefined
  working: boolean
  includeCold?: boolean
  className?: string
}): React.ReactElement | null {
  const now = usePromptCacheMarkNow(reading, working, includeCold)
  if (working) return null
  const state = promptCacheState(reading, now)
  if (!promptCacheNeedsAttention(state) || (state.kind === 'cold' && !includeCold)) return null
  const { label, detail } = promptCacheCopy(state, now)
  return (
    <span
      role="img"
      aria-label={`${label}. ${detail}`}
      title={`${label}\n${detail}`}
      className={`flex shrink-0 items-center ${
        state.kind === 'expiring' ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-subtle)]'
      } ${className ?? ''}`}
    >
      <CompactGlyph className="icon-xs" />
    </span>
  )
}
