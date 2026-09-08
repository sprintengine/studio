import React from 'react'

import { FOCUS_RING_CLASS } from './tokens'

// The CHIP — a content-height pill that toggles, filters, or names one thing
// (design-system/components/chip-button).
//
// A view-mode segment on a canvas header. A zoom readout. A branch step in a
// wizard's trail. An epic pill on a backlog card. A "DEBUG" preset that throws a
// tinted ground. Thirty-odd of these, and the reason none of them could be a
// `GhostButton` or an `OutlineButton` is one line: **every kit button size pins a
// ramp height**, and a chip's height is its line box. A chip sits INSIDE a row
// that has already decided how tall it is, and a 26px control there sets the
// row's height instead of riding it. Passing `py-*` through `className` does not
// fix it — the caller's `py-` and the size step's `h-` are different properties,
// and the `h-` wins.
//
// So the chip spends its size on the inset and the type, and nothing else.
// `text-micro` at rest, because a chip is a label about the thing beside it, and
// it must not outweigh what it qualifies.
//
// It carries no elevation at any state. It is not a control standing off the
// page; it is a mark ON one (`principles.md` → Hairlines carry the structure).

/**
 * - `ghost` (default) — no edge, no ground. A toggle in a chrome strip.
 * - `outline` — a `border.default` hairline over `bg.surface-raised`. A chip
 *   that has to be findable on a busy surface: a wizard's branch step, a
 *   related-node chip on a canvas.
 * - `overlay` — the form a chip takes when it FLOATS over content rather than
 *   sitting in the flow: a canvas HUD control, a badge over a pan/zoom surface.
 *   `radius.overlay` and a `border.default` edge on `bg.surface`, so it reads as
 *   a small floating surface rather than as part of what is underneath. Still no
 *   shadow: the elevation ramp is for surfaces a person opened, not for chrome
 *   that was always there.
 */
export type ChipVariant = 'ghost' | 'outline' | 'overlay'

/**
 * The chip's ink at rest, and the ONE reason `tone` is a prop rather than a
 * `className`: two `text-[color:var(--…)]` utilities of equal specificity are
 * resolved by stylesheet order.
 *
 * - `subtle` (default) — `text.subtle`, lifting to `text.default`.
 * - `neutral` — `text.default`, lifting to `text.primary`. One step up, for a
 *   chip whose label is the row's own information rather than a qualifier.
 * - `warn` / `error` — a STANDING warning the chip itself carries: scripts are
 *   running in this preview, permissions are bypassed on this preset. The
 *   thrown state fills the tone's soft tint with its on-tint ink, which is what
 *   keeps the label legible on the fill. Never a status DOT's job — a chip and
 *   a dot saying the same thing is the badge/dot collision the system rejects
 *   on sight; use this only where the chip IS the control.
 */
export type ChipTone = 'subtle' | 'neutral' | 'warn' | 'error'

const RESTING_INK: Record<ChipTone, string> = {
  subtle:
    'text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)] ' +
    'disabled:hover:text-[color:var(--text-subtle)]',
  neutral:
    'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:text-[color:var(--text-default)]',
  warn:
    'text-[color:var(--tone-warn)] hover:text-[color:var(--tone-warn)] ' +
    'disabled:hover:text-[color:var(--tone-warn)]',
  error:
    'text-[color:var(--tone-error)] hover:text-[color:var(--tone-error)] ' +
    'disabled:hover:text-[color:var(--tone-error)]',
}

// The EDGE, per variant. Held through every state — a border that appeared when
// a chip was thrown would resize the row it sits in, which is the layout shift
// the hover rule already forbids.
const EDGE: Record<ChipVariant, string> = {
  ghost: '',
  outline:
    'border border-[color:var(--border-default)] hover:border-[color:var(--border-strong)] ' +
    'disabled:hover:border-[color:var(--border-default)]',
  overlay:
    'border border-[color:var(--border-default)] hover:border-[color:var(--border-strong)] ' +
    'disabled:hover:border-[color:var(--border-default)]',
}

// The ground it rests on while NOT thrown. Each branch declares `bg-` and
// `hover:bg-` exactly once, and the thrown map below is the other branch: one
// declaration per property reaches the element either way.
const RESTING_GROUND: Record<ChipVariant, string> = {
  ghost: 'bg-transparent hover:bg-[color:var(--bg-hover)] disabled:hover:bg-transparent',
  outline:
    'bg-[color:var(--bg-surface-raised)] hover:bg-[color:var(--bg-hover)] ' +
    'disabled:hover:bg-[color:var(--bg-surface-raised)]',
  overlay:
    'bg-[color:var(--bg-surface)] hover:bg-[color:var(--bg-hover)] ' +
    'disabled:hover:bg-[color:var(--bg-surface)]',
}

// The thrown fill, held under the pointer. Neutral for the two neutral tones,
// because selection is neutral; the tone tints keep their own hue, because a
// thrown "DEBUG" that went grey would stop saying what it says.
const THROWN: Record<ChipTone, string> = {
  subtle:
    'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ' +
    'hover:bg-[color:var(--bg-selected)] disabled:hover:bg-[color:var(--bg-selected)]',
  neutral:
    'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ' +
    'hover:bg-[color:var(--bg-selected)] disabled:hover:bg-[color:var(--bg-selected)]',
  warn:
    'bg-[color:var(--tone-warn-soft)] text-[color:var(--tone-warn-on-tint)] ' +
    'hover:bg-[color:var(--tone-warn-soft)] disabled:hover:bg-[color:var(--tone-warn-soft)]',
  error:
    'bg-[color:var(--tone-error-soft)] text-[color:var(--tone-error-on-tint)] ' +
    'hover:bg-[color:var(--tone-error-soft)] disabled:hover:bg-[color:var(--tone-error-soft)]',
}

export type ChipButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ChipVariant
  tone?: ChipTone
  /** A toggle that is currently ON. Tri-state, exactly as `IconButton`'s:
   *  undefined on a chip that is not a toggle, `false` on one that is off.
   *  Supplies `aria-pressed` when the caller has not. */
  pressed?: boolean
  /** One of a set, and this is the one in force — a view mode, a branch step.
   *  Draws the same fill as `pressed` and announces `aria-current` instead,
   *  because "the step you are on" is a place, not a switch. */
  selected?: boolean
  /**
   * The chip carries an IDENTITY colour of its own — an epic's hue, a bucket's.
   * The value is a CSS colour the caller resolves per item, applied as an inline
   * style because there is one per epic and no token can name them all.
   *
   * It paints the ink and a soft ground mixed from the same value, never a solid
   * fill: an identity hue is a name, not a status or an emphasis
   * (`principles.md` → Identity colour). Ignored while `pressed`/`selected` —
   * a thrown chip is a state, and a state outranks an identity.
   */
  tint?: string
}

export const ChipButton = React.forwardRef<HTMLButtonElement, ChipButtonProps>(function ChipButton(
  { className, variant = 'ghost', tone = 'subtle', pressed, selected, tint, style, type, ...rest },
  ref,
) {
  const thrown = pressed === true || selected === true
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-pressed={pressed}
      aria-current={selected ? 'true' : undefined}
      style={
        tint && !thrown
          ? {
              // 12% is the same weight the tone-soft tokens carry, so an epic
              // pill and a warn chip sit at the same depth on the surface.
              color: tint,
              backgroundColor: `color-mix(in srgb, ${tint} 12%, transparent)`,
              ...style,
            }
          : style
      }
      {...rest}
      className={[
        // Content height: the line box is the height, so the chip rides the row
        // it is in. `min-w-0` so a truncating label inside can actually shrink.
        'interactive inline-flex min-w-0 items-center gap-1 text-micro font-medium transition-colors',
        variant === 'overlay' ? 'rounded-md' : 'rounded-xs',
        'px-1.5 py-0.5',
        EDGE[variant],
        thrown ? THROWN[tone] : `${RESTING_GROUND[variant]} ${tint ? '' : RESTING_INK[tone]}`,
        'disabled:cursor-not-allowed disabled:opacity-45',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})
