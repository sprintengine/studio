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
// appearing on hover and shifting the layout"). `OutlineButton` presses by the
// `.interactive` scale, and a tile that shrank under the finger would pull out
// of line with its neighbours.
//
// `raised` is the one tile that is a pressable control standing on its own
// (owner ruling 2026-10-01): a launcher tile — the empty pane's Browser /
// Terminal / Files grid — whose whole job is to be pressed once. Since the
// control tiers (owner ruling 2026-10-04) it is tier 2: flat on its hairline,
// with no shadow and no sheen. It answers the press with one more step of
// ground and the strong edge, never with a scale.

/**
 * - `plain` (default) — no edge. The tile IS its content: a preview iframe, a
 *   specimen, a picture. The hover ground is the whole affordance.
 * - `bordered` — a `border.default` hairline over `bg.surface`, lifting to
 *   `border.strong`. For a tile whose content does not draw its own box: a
 *   summary tile, a theme card, a graph node. The border is present at rest, so
 *   it appears at no point and moves nothing.
 * - `raised` — `bordered`'s hairline over `bg.surface-raised`, flat, stepping to
 *   `bg.active` and `border.strong` while held. For a LAUNCHER tile: one of a
 *   grid of things to open, pressed once and gone. The name predates the
 *   2026-10-04 ruling that took its shadow away, and stays because callers
 *   import it.
 */
export type CardVariant = 'plain' | 'bordered' | 'raised'

const RESTING: Record<CardVariant, string> = {
  plain: 'bg-transparent hover:bg-[color:var(--bg-hover)] ' + 'disabled:hover:bg-transparent',
  bordered:
    'border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] ' +
    'hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] ' +
    'disabled:hover:border-[color:var(--border-default)] disabled:hover:bg-[color:var(--bg-surface)]',
  raised:
    'border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] ' +
    'hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] ' +
    'enabled:active:border-[color:var(--border-strong)] enabled:active:bg-[color:var(--bg-active)] ' +
    'disabled:hover:border-[color:var(--border-default)] disabled:hover:bg-[color:var(--bg-surface-raised)]',
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
  // A chosen launcher tile is a place you are, not a thing to press, so it
  // takes the selection fill the way `bordered` does.
  raised:
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
        'flex flex-col text-left transition-colors',
        // `rounded-md` unless the caller names a radius of its own: a tile set
        // under the composer rounds with it (`radius.composer-companion`), and
        // two radii on one element would be settled by stylesheet order.
        /(?:^|\s)rounded(?:-|\s|$)/.test(className ?? '') ? '' : 'rounded-md',
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
