import React from 'react'

import { TONE_COLOR_VAR, TONE_SOFT_VAR, type Tone } from './tokens'

// The kit's badge (MC-2117). "Badge" appeared across a dozen files as ad-hoc
// rounded spans, and the audit found two distinct species hiding under the one
// word — so this exports both rather than pretending they are one control:
//
//   count  a numeric counter: circular at one digit, pill beyond it, tabular
//          figures so 1 → 2 does not jog the layout. Optionally pinned to the
//          corner of a trigger, which is what the notification bell, the
//          attention queue and the git change count each rebuilt.
//   label  a short word about the row it sits on ("Blocked", "Waiting") in a
//          soft tone fill with a hairline.
//
// Both take a `Tone` rather than colours. The counters that shipped hardcoded
// `--bg-app` as their ink, which is only legible while the badge is on a
// saturated tone — `--text-on-accent` is the token that means "foreground for a
// filled surface" and holds on every theme.

export type BadgeTone = Tone

export type BadgeProps = {
  tone?: BadgeTone
  /** The word. Ignored when `count` is set. */
  children?: React.ReactNode
  /** Renders the counter species instead of the label species. */
  count?: number
  /** Counters above this render as "N+". Omit for no cap. */
  max?: number
  /**
   * Pin to the top-right of the nearest positioned ancestor, with a ring in the
   * surface colour so the badge reads as sitting ON the trigger rather than
   * inside it. The host must be `relative`.
   */
  corner?: boolean
  /** Accessible name. A bare number ("3") tells a screen reader nothing. */
  ariaLabel?: string
  /**
   * Hide from assistive tech — correct when adjacent text already carries the
   * meaning, so the badge is not read twice.
   */
  decorative?: boolean
  className?: string
}

export function Badge({
  tone = 'neutral',
  children,
  count,
  max,
  corner = false,
  ariaLabel,
  decorative = false,
  className,
}: BadgeProps): JSX.Element {
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'status', 'aria-label': ariaLabel } as const)

  if (count !== undefined) {
    const shown = max !== undefined && count > max ? `${max}+` : String(count)
    return (
      <span
        {...a11y}
        style={{ backgroundColor: TONE_COLOR_VAR[tone] }}
        className={[
          // `min-w-4` with `px-1`: a single digit stays a circle, two or more
          // grow it into a pill rather than clipping.
          'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1',
          'text-micro font-bold leading-none tabular-nums text-[color:var(--text-on-accent)]',
          corner
            ? // A border in the app ground, so the badge reads as sitting ON the
              // trigger rather than inside it. An inset ring would hold the box
              // at exactly 16px, but `lint-design-tokens`' `no-glow-shadow` rule
              // forbids that spelling outright — and every shipped counter this
              // replaces already used a border, so this is their behaviour
              // rather than a compromise introduced here.
              'absolute -right-1 -top-1 border border-[color:var(--bg-app)]'
            : '',
          className ?? '',
        ].join(' ')}
      >
        {shown}
      </span>
    )
  }

  return (
    <span
      {...a11y}
      style={{ backgroundColor: TONE_SOFT_VAR[tone], borderColor: TONE_COLOR_VAR[tone] }}
      className={[
        'inline-flex min-w-0 items-center gap-1 rounded-full border px-1.5',
        'text-micro font-medium leading-4 text-[color:var(--text-muted)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </span>
  )
}
