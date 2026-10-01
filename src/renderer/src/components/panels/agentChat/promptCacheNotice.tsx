// The composer tray's row when a chat's prompt cache is about to go cold or
// already has: when, and how many tokens that puts at stake — with the
// compaction that makes the next message, and every one after it, smaller.

import { useState } from 'react'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { GhostButton } from '../../ui'
import type { PromptCacheReading } from '../../../../../shared/prompt-cache'
import { promptCacheNeedsAttention, promptCacheNoticeLine, promptCacheState } from '../../workspace/promptCacheState'
import { ComposerTrayRow } from './composerTray'
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
  const [dismissed, setDismissed] = useState<string | null>(null)
  // No clock for a reading already set aside: nothing it says is on screen.
  const now = useRelativeNow(30_000, reading !== null && !busy && dismissed !== readingKey(reading))
  if (busy || !reading || dismissed === readingKey(reading)) return null
  const state = promptCacheState(reading, now)
  if (!promptCacheNeedsAttention(state)) return null
  return (
    <ComposerTrayRow
      tone="warn"
      actions={
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
    >
      {promptCacheNoticeLine(state, now)}
    </ComposerTrayRow>
  )
}
