import React from 'react'

import { FOCUS_RING_CLASS } from './tokens'

// The TILE — a block-level button whose content is a composition rather than a
// label (design-system/components/card-button).
//
// A preview frame over two caption lines. A theme swatch over a name. A graph
// node the canvas positions absolutely. An Extensions home tile: glyph, name,
// one-line summary, a live count, a chevron. Every kit button is
// `inline-flex … justify-center` on a ramp height with a label typography of its
// own, so each of these began by cancelling the height, the centring and the
// `font-medium` — and two `justify-*` or two `h-*` on one element are resolved
// by stylesheet ORDER, not by the order they appear in a class string.
//
// The rule this exists to hold, and the reason it is not `OutlineButton` with a
// `flex-col`: **hover changes the ground and nothing else.** No border appearing,
// no shadow, no scale. A tile lives in a grid, and a grid that reflows under the
// pointer is the defect (`principles.md` → Selection and focus: "no border
// appearing on hover and shifting the layout"). `OutlineButton` carries
// `control-edge`, which is elevation, and elevation in the document flow is
// exactly what the hairline principle rules out for anything that is not a
// pressable control standing on its own.

/**
 * - `plain` (default) — no edge. The tile IS its content: a preview iframe, a
 *   specimen, a picture. The hover ground is the whole affordance.
 * - `bordered` — a `border.default` hairline over `bg.surface`, lifting to
 *   `border.strong`. For a tile whose content does not draw its own box: a
 *   summary tile, a theme card, a graph node. The border is present at rest, so
 *   it appears at no point and moves nothing.
 */
export type CardVariant = 'plain' | 'bordered'

const RESTING: Record<CardVariant, string> = {
  plain: 'bg-transparent hover:bg-[color:var(--bg-hover)] ' + 'disabled:hover:bg-transparent',
  bordered:
    'border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] ' +
    'hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] ' +
    'disabled:hover:border-[color:var(--border-default)] disabled:hover:bg-[color:var(--bg-surface)]',
}

// Selection on a tile is the same neutral canon a row takes — the fill, the ink
// lift, the inset edge read through `--selection-edge` — because a chosen tile
// and a chosen row are the same fact in two layouts. Hover is skipped while
// selected: `--bg-hover` sits below `--bg-selected`, so letting it win would dim
// the tile the pointer is over.
const SELECTED: Record<CardVariant, string> = {
  plain:
    'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ' +
    'ring-2 ring-inset ring-[color:var(--selection-edge)]',
  bordered:
    'border border-[color:var(--border-strong)] bg-[color:var(--bg-selected)] ' +
    'text-[color:var(--text-strong)] ring-2 ring-inset ring-[color:var(--selection-edge)]',
}

export type CardButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: CardVariant
  /** This tile is the chosen one. Supplies `aria-pressed` when the caller has
   *  not — a tile in a grid of alternatives is a choice you throw, where a row
   *  in a list is somewhere you are (`RowButton` reads `aria-current`). */
  selected?: boolean
}

export const CardButton = React.forwardRef<HTMLButtonElement, CardButtonProps>(function CardButton(
  { className, variant = 'plain', selected, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-pressed={selected}
      // The canvas cases position and size themselves — an absolutely placed
      // graph node with `style` left/top/width, a grid cell with its own span —
      // so `style`, `data-*` and the rest land on the button untouched.
      {...rest}
      className={[
        // Column flow and left alignment; NO padding, because a tile's inset is
        // a composition decision (a preview frame wants 4px, a summary tile
        // wants 12px over 10px) and a default here would be one more utility
        // every caller had to out-specify.
        'flex flex-col rounded-md text-left transition-colors',
        // No `.interactive`: the press scale on a grid tile moves its neighbours'
        // apparent alignment, and a tile's press is already the ground.
        selected === true ? SELECTED[variant] : RESTING[variant],
        'disabled:cursor-not-allowed disabled:opacity-45',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})
