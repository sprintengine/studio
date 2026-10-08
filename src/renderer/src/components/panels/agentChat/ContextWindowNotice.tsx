import { useEffect, useState } from 'react'
import { GhostButton } from '../../ui'
import { formatTokenCount } from '../../../utils/tokenFormat'
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
      Context {Math.min(100, Math.round(fraction * 100))}% full · {formatTokenCount(used)} of {formatTokenCount(total)}{' '}
      tokens
    </ComposerTrayRow>
  )
}
