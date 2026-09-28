import type { LifecycleState } from '../../../../shared/lifecycle-state'
import { AgentWorkingDots } from './AgentWorkingDots'
import { LifecycleGlyph } from './LifecycleGlyph'
import { STATUS_TONE_COLOR_VAR, type StatusTone } from './tokens'

/**
 * The status mark. The app draws no status dots (owner ruling 2026-09-28): a
 * 6px disc has no shape, so every tone was the same circle and "working" read
 * the same as "waiting" and "failed". The name stays because modules import it
 * through the SDK; what it draws is the shape-coded vocabulary the rest of the
 * app already reads state by.
 *
 * - A live good or accent tone — something running right now — is the working
 *   dots, the one "working" mark the sidebar, the tabs and the peek card share.
 * - Every other tone is a lifecycle glyph in that tone's ink: danger is a ring
 *   with "×", warn a ring with "!", good a check, neutral a ring with a bar
 *   (off), accent a held arc, merged a check in the merged ink. A pulsing one
 *   (waiting on someone, recording) breathes.
 */
const TONE_SHAPE: Record<StatusTone, LifecycleState> = {
  error: 'failed',
  warn: 'needs_input',
  good: 'done',
  merged: 'done',
  neutral: 'blocked',
  accent: 'in_progress',
}

type StatusDotProps = {
  tone: StatusTone
  /** The state is live: a good or accent tone draws the working dots, any
   *  other breathes. Reduced motion is honored globally in index.css. Use
   *  sparingly — only for live indicators. */
  pulse?: boolean
  /** Accessible label. Omit when the mark is purely decorative beside text that
   *  already describes the same state. */
  label?: string
  /** The glyph's size in px. Defaults to the inline icon size (`--icon-xs`). */
  size?: number
  className?: string
}

export function StatusDot({ tone, pulse = false, label, size, className }: StatusDotProps) {
  if (pulse && (tone === 'good' || tone === 'accent')) return <AgentWorkingDots label={label} className={className} />
  const side = size ?? 'var(--icon-xs)'
  return (
    <LifecycleGlyph
      state={TONE_SHAPE[tone]}
      label={label}
      live={false}
      className={`${pulse ? 'status-dot-pulse' : ''} ${className ?? ''}`}
      style={{ color: STATUS_TONE_COLOR_VAR[tone], width: side, height: side }}
    />
  )
}
