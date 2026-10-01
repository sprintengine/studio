// The prompt cache on the surfaces that show an agent at rest: a mark on its
// tab and sidebar line when the cache is about to go cold or has, and a line on
// its card that says what that costs and offers to compact.

import React, { useEffect, useState } from 'react'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { showToast } from '../../store/toastStore'
import { GhostButton, Tooltip } from '../ui'
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

/**
 * The card's line: the cache's state in words, what the next message costs
 * when it matters, and — for an agent this app can type `/compact` at — the
 * button that does. `compact` is null where there is no such action (a chat,
 * whose own composer offers it; a CLI that is not Claude Code), and carries the
 * reason it is not available right now otherwise.
 */
export function PromptCacheCardLine({
  sessionId,
  reading,
  working,
  compact,
}: {
  sessionId: string
  reading: PromptCacheReading | null | undefined
  working: boolean
  compact: { blocker: string | null } | null
}): React.ReactElement | null {
  const now = useRelativeNow(CLOCK_MS, Boolean(reading) && !working)
  const [pending, setPending] = useState(false)
  const state = working ? null : promptCacheState(reading, now)
  if (!state) return null
  const attention = promptCacheNeedsAttention(state)
  const { label, detail } = promptCacheCopy(state, now)
  const compactNow = async () => {
    setPending(true)
    try {
      const result = await window.api.compactAgentSession(sessionId)
      if (!result.ok) showToast({ tone: 'warn', title: 'Could not compact', description: result.message })
    } catch (error) {
      showToast({ tone: 'error', title: 'Could not compact', description: String(error) })
    } finally {
      setPending(false)
    }
  }
  const button =
    attention && compact ? (
      <GhostButton size="xs" disabled={pending || compact.blocker !== null} onClick={() => void compactNow()}>
        <CompactGlyph className="icon-xs" />
        {pending ? 'Compacting…' : 'Compact'}
      </GhostButton>
    ) : null
  return (
    <div className="flex items-start gap-2 px-3 pb-1 pt-2 text-meta">
      <div className="min-w-0 flex-1">
        <div
          className={
            attention && state.kind === 'expiring'
              ? 'text-[color:var(--tone-warn)]'
              : attention
                ? 'text-[color:var(--text-default)]'
                : 'text-[color:var(--text-subtle)]'
          }
        >
          {label}
        </div>
        {attention ? <div className="mt-0.5 leading-5 text-[color:var(--text-muted)]">{detail}</div> : null}
      </div>
      {button && compact?.blocker ? (
        // Disabled, with the reason: the button is where a person looks for it.
        <Tooltip content={compact.blocker} wrapperClassName="flex shrink-0">
          <span>{button}</span>
        </Tooltip>
      ) : button ? (
        <span className="flex shrink-0">{button}</span>
      ) : null}
    </div>
  )
}
