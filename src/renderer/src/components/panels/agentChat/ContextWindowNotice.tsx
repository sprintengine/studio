import { useEffect, useState } from 'react'
import { GhostButton } from '../../ui'
import { ComposerTrayRow } from './composerTray'
import { CompactGlyph } from './toolRows/ToolKindGlyph'

// Where the context window counts as nearly full: the composer tray says so in
// words. (The strip's ring turns amber earlier, at its own threshold — a
// glance's nudge before the words.)
const CONTEXT_NEAR_FULL = 0.9

// The context window nearly full, as a row of the composer tray. Compacting is
// offered where the chat's CLI runs `/compact`. "Not now" holds until the window
// drops back under the mark — a compaction, or a new session — so a window
// that fills again says so again.
export function ContextWindowNotice({
  used,
  total,
  onCompact,
  compactDisabled,
}: {
  used: number
  total: number
  onCompact?: () => void
  compactDisabled: boolean
}) {
  const fraction = total > 0 ? used / total : 0
  const nearFull = fraction >= CONTEXT_NEAR_FULL
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    if (!nearFull) setDismissed(false)
  }, [nearFull])
  if (!nearFull || dismissed) return null
  return (
    <ComposerTrayRow
      tone="warn"
      actions={
        <>
          {onCompact ? (
            <GhostButton size="xs" disabled={compactDisabled} onClick={onCompact}>
              <CompactGlyph className="icon-xs" />
              Compact
            </GhostButton>
          ) : null}
          <GhostButton size="xs" onClick={() => setDismissed(true)}>
            Not now
          </GhostButton>
        </>
      }
    >
      Context {Math.min(100, Math.round(fraction * 100))}% full · {formatTokens(used)} of {formatTokens(total)} tokens
    </ComposerTrayRow>
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}
