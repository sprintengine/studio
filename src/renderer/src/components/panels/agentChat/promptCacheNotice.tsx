// The notice above a chat's composer when its prompt cache is about to go cold
// or already has: what the next message will cost, and the compaction that
// makes it — and everything after it — smaller.

import { useState } from 'react'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { GhostButton, InlineNotice } from '../../ui'
import type { PromptCacheReading } from '../../../../../shared/prompt-cache'
import { promptCacheCopy, promptCacheNeedsAttention, promptCacheState } from '../../workspace/promptCacheState'
import { CompactGlyph } from './toolRows/ToolKindGlyph'

// What a dismissal is about: this reading. The next request writes a new one,
// and a cache that goes cold after that is news again.
function readingKey(reading: PromptCacheReading): string {
  return `${reading.expiresAt ?? 'cold'}:${reading.recacheTokens ?? ''}`
}

export function PromptCacheComposerNotice({
  reading,
  busy,
  onCompact,
}: {
  reading: PromptCacheReading | null
  /** A turn is running or a send is in flight: every request refreshes the cache, and a compaction would queue. */
  busy: boolean
  onCompact: () => void
}) {
  const now = useRelativeNow(30_000, reading !== null && !busy)
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (busy || !reading || dismissed === readingKey(reading)) return null
  const state = promptCacheState(reading, now)
  if (!promptCacheNeedsAttention(state)) return null
  const { label, detail } = promptCacheCopy(state, now)
  return (
    <InlineNotice
      tone="warn"
      className="mb-2"
      title={label}
      hint={detail}
      action={
        <>
          <GhostButton size="xs" onClick={onCompact}>
            <CompactGlyph className="icon-xs" />
            Compact
          </GhostButton>
          <GhostButton size="xs" onClick={() => setDismissed(readingKey(reading))}>
            Not now
          </GhostButton>
        </>
      }
    />
  )
}
