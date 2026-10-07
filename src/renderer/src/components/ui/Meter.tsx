import React, { type JSX } from 'react'

// Meter — how much of a known budget is spent, as a bar filled from the left
// (design-system/components/meter).
//
// A DISPLAY of one proportion, never a control and never a progress indicator:
// nothing is loading, and the value falls back to nothing when the budget
// refills. A bar rather than the context ring because meters are read in a
// column, one under another, where bars of one length compare at a glance.
//
// The bar never says its own number. The caller writes what it measures and
// how much beside it, and names the bar with `ariaLabelledBy` (or, compact
// inside a control, leaves it decorative and names the control).

export function Meter({
  value,
  marker,
  warn = false,
  compact = false,
  ariaLabelledBy,
  ariaValueText,
  className,
}: {
  /** 0–100, or null when there is no value to show (the track alone, quieter). */
  value: number | null
  /** 0–100: a second point the value is read against, drawn as a tick. */
  marker?: number | null
  /** Close to or at the limit: the fill takes `status.warn`. */
  warn?: boolean
  /** The 16 × 4px mark for inside a control; decorative there. */
  compact?: boolean
  ariaLabelledBy?: string
  /** The value in words ("82% used", "Reset"). */
  ariaValueText?: string
  className?: string
}): JSX.Element {
  const share = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value))
  const tick =
    marker === null || marker === undefined || !Number.isFinite(marker) ? null : Math.max(0, Math.min(100, marker))
  const style: React.CSSProperties = {}
  if (share !== null) (style as Record<string, string>)['--meter-value'] = String(share / 100)
  if (tick !== null) (style as Record<string, string>)['--meter-marker'] = String(tick / 100)
  return (
    <span
      {...(compact
        ? { 'aria-hidden': true }
        : {
            role: 'meter',
            'aria-labelledby': ariaLabelledBy,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            ...(share !== null ? { 'aria-valuenow': Math.round(share) } : {}),
            'aria-valuetext': ariaValueText,
          })}
      data-meter={warn ? 'warn' : share === null ? 'unknown' : 'default'}
      style={style}
      className={[
        // The track's edge is an inset shadow, as the slider's groove is: a
        // border would take a pixel out of the box the fill is measured against.
        'relative block shrink-0 rounded-full bg-[color:var(--bg-active)] shadow-[inset_0_0_0_1px_var(--border-default)]',
        compact ? 'h-1 w-4' : 'h-1.5 w-full',
        share === null ? 'opacity-60' : '',
        className ?? '',
      ].join(' ')}
    >
      {share !== null ? (
        <span
          className={`absolute inset-y-0 left-0 w-[calc(var(--meter-value)*100%)] rounded-full ${
            warn ? 'bg-[color:var(--tone-warn)]' : 'bg-[color:var(--accent-primary)]'
          }`}
        />
      ) : null}
      {tick !== null && !compact ? (
        <span className="absolute -inset-y-0.5 left-[calc(var(--meter-marker)*100%-1px)] w-0.5 rounded-full bg-[color:var(--text-subtle)]" />
      ) : null}
    </span>
  )
}
