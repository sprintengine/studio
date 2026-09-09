import React from 'react'

import { Tooltip } from './Tooltip'
import { FOCUS_RING_CLASS } from './tokens'

// ContextRing — how much of a model's context window a conversation has spent,
// as a 14px circle filled clockwise from twelve
// (design-system/components/context-ring).
//
// The shape is borrowed rather than invented: Claude Code, Cursor and ChatGPT
// all draw this ring for this fact, so it arrives already legible. Which is
// also why it is a ring and not a bar or a number — a number has to be read,
// and this sits beside a title at 14px with no room to read one. The number is
// still there, in the tooltip and in the accessible name, for anyone who wants
// it.
//
// A DISPLAY of one proportion, never a control and never a progress indicator:
// nothing is loading, and the value falls as well as rises (a compaction gives
// context back).

/**
 * Past this share of the window a compaction is close, and the fill takes
 * `status.warn`. The only other tone the ring ever wears — there is no danger
 * tier, because a full context window is not a failure.
 */
export const CONTEXT_RING_WARN_PERCENTAGE = 80

/** Geometry of the drawn ring, in the SVG's own 16-unit box. */
const RING_RADIUS = 6
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * The ring, or null when there is nothing to draw.
 *
 * A ring at 0% and a ring for a session whose runtime reports no usage are the
 * same picture, and one of them is a lie — so the CALLER omits the component
 * when it holds no reading. This one only refuses a value that is not a number
 * at all, which is a bad payload rather than an absent one.
 */
export function ContextRing({
  usedPercentage,
  layer,
  className,
}: {
  /** 0–100. Clamped and rounded here: the tooltip and the sweep must agree. */
  usedPercentage: number
  /**
   * Which layer the tooltip sits on. `menu` when the ring is inside a
   * menu-tier surface (a `PointerPopover`), or its description paints under
   * the card that owns it. See `Tooltip`.
   */
  layer?: 'popover' | 'menu'
  className?: string
}): JSX.Element | null {
  if (!Number.isFinite(usedPercentage)) return null
  const percentage = Math.max(0, Math.min(100, Math.round(usedPercentage)))
  // One sentence, used twice on purpose: as the accessible name, so the mark is
  // never an unnamed graphic, and as the tooltip, so a pointer gets the same
  // answer a screen reader does.
  const label = `Context ${percentage}% used`
  const high = percentage >= CONTEXT_RING_WARN_PERCENTAGE
  // The dash is the spent arc, the gap the whole circumference — so the sweep
  // is the value and nothing else has to be computed at paint time.
  const sweep = (RING_CIRCUMFERENCE * percentage) / 100
  return (
    <Tooltip content={label} layer={layer} wrapperClassName="flex shrink-0">
      <span
        role="img"
        aria-label={label}
        // Focusable, because a tooltip that only a pointer can summon is not a
        // reveal (design-system/components/tooltip → Accessibility).
        tabIndex={0}
        // A 24px hit target around a 14px mark, pulled back by 5px each side so
        // the target never grows the line it sits in.
        // design-tokens-allow: geometry, not spacing — `-my-[5px]` is exactly (hit-target-min − 14) / 2, the overhang of the hit target around the mark. Rounding it to a 4px or 6px space step would leave the target either 2px proud of the line or 2px short of the 24px floor; the value is derived from the mark's diameter, which no space token names (see design-system/components/context-ring).
        className={`-my-[5px] inline-grid size-[var(--hit-target-min)] shrink-0 place-items-center rounded-full ${FOCUS_RING_CLASS} ${className ?? ''}`}
      >
        <svg viewBox="0 0 16 16" className="block h-[14px] w-[14px]" aria-hidden="true">
          {/* The unspent remainder. `border.strong`, not a status tone: a
              coloured track would read as a second value. */}
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-[color:var(--border-strong)]"
          />
          {/* The spent sweep. `butt` caps because a round cap at 2px overhangs
              by about a degree, which draws a visible dot at 0%. */}
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="butt"
            strokeDasharray={`${sweep.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`}
            // Deliberate tempo, because the value moves in visible steps as a
            // turn ends and a step that snapped would read as a glitch.
            className={`origin-center -rotate-90 transition-[stroke-dasharray] duration-[var(--motion-deliberate)] motion-reduce:transition-none ${
              high ? 'stroke-[color:var(--tone-warn)]' : 'stroke-[color:var(--accent-primary)]'
            }`}
          />
        </svg>
      </span>
    </Tooltip>
  )
}
