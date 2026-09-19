import React from 'react'

import { FOCUS_RING_CLASS, FOCUS_RING_INSET_CLASS } from './tokens'

// The list ROW as a control — the single most repeated shape in the product and
// the one the kit had no member for.
//
// `ui/Buttons` answers "a thing you press"; `ui/InboxRow` answers "a worklist
// row with a title, a supporting line and revealed actions". Between them sat
// forty-odd hand-rolls of a third thing: a full-width, left-aligned, content-
// height button whose CHILDREN are the layout — a rail row with three stacked
// lines, a listbox option, a settings rail tab, a "New …" affordance, a skill
// file path with a size on the end. Every kit button is `inline-flex …
// justify-center` at a ramp height with an ink of its own, so each of those
// began by cancelling four utilities it could not safely cancel: two `justify-*`
// or two `h-*` on one element are resolved by stylesheet ORDER, not by the order
// they appear in a class string.
//
// What they share, and what this states once: the width, the alignment, the
// hover ground, the selection fill with its edge and its suppressed hover, the
// focus ring the density picks, and the disabled canon. What stays with the
// caller is everything inside the row — the glyph slot, the lines, the trailing
// meta — because that is the part that genuinely differs.
//
// Reach for `InboxRow` when the row IS the worklist row that spec describes.
// Reach for this when the row is a rail entry, an option, a tab or a create
// affordance, and for the row shape `InboxRow` does not name.

/**
 * How much surface the row owns.
 *
 * - `row` (default) — an inset row inside a padded rail: `radius.overlay`, its
 *   own fill, an OUTSET focus ring (the row does not touch its container's
 *   edge, so the ring has room).
 * - `nav` — the same, on the sidebar's navigation rhythm: a `size.control.sm`
 *   floor so a one-line door row matches the controls above it, and a tighter
 *   block inset so a two-line row still grows.
 * - `bleed` — a FULL-BLEED row in a list that reaches its container's edges: no
 *   radius (an inset rounded fill inside a padded surface reads as a card in a
 *   card, and every other row list in the system fills to its own inset), and an
 *   INSET focus ring, because an outset one is clipped by the edge the row
 *   touches.
 * - `flush` — a row half that draws NO surface of its own in any state: the
 *   wrapping element owns the hover fill and the radius, and this is one of two
 *   targets inside it. Inset ring, for the same reason as `bleed`.
 */
export type RowButtonDensity = 'row' | 'nav' | 'bleed' | 'flush'

/**
 * `dashed` is the "New …" affordance at the head or the foot of a rail — the
 * first part of the list-surface anatomy (`principles.md` → Composition). A 1px
 * dashed `border.default` is the one place the system draws a dashed edge, and
 * it earns it: the row is a PLACE for a thing that does not exist yet, and a
 * solid edge would make it look like the first item in the list.
 */
export type RowButtonVariant = 'plain' | 'dashed'

const DENSITY: Record<RowButtonDensity, string> = {
  row: 'rounded-md px-2 py-1.5',
  nav: 'rounded-md min-h-control-sm px-2 py-1',
  bleed: 'px-2 py-1.5',
  flush: 'px-2 py-1.5',
}

const DENSITY_FOCUS: Record<RowButtonDensity, string> = {
  row: FOCUS_RING_CLASS,
  nav: FOCUS_RING_CLASS,
  bleed: FOCUS_RING_INSET_CLASS,
  flush: FOCUS_RING_INSET_CLASS,
}

// Selection is the canon `ui/InboxRow` already draws, spelled the same way so a
// rail row and a worklist row cannot disagree: the neutral `bg.selected` fill,
// the 2px inset edge read through `--selection-edge` (so a pane that is not
// driving the keyboard drops it to transparent through the `data-selection-pane`
// cascade), and the row's ink lifted to `text.primary`.
//
// Hover is SKIPPED while selected rather than restated: `--bg-hover` sits below
// `--bg-selected` on the surface ramp, so letting it win would dim the row the
// pointer is over — which reads as the row un-selecting itself.
const SELECTED =
  'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ' +
  'ring-2 ring-inset ring-[color:var(--selection-edge)]'

const RESTING: Record<RowButtonVariant, string> = {
  plain:
    'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-default)]',
  dashed:
    'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]',
}

// `flush` draws no ground at any state — the wrapper it sits in owns the fill —
// so it takes the ink half of the pair and nothing else.
const RESTING_FLUSH =
  'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)] ' +
  'disabled:hover:text-[color:var(--text-default)]'

export type RowButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  density?: RowButtonDensity
  variant?: RowButtonVariant
  /**
   * The row is the CHOSEN one. Paints the selection canon above and supplies
   * `aria-current="true"` when the caller has not said otherwise.
   *
   * `aria-current`, not `aria-pressed`: a list row is navigation — "this is the
   * one you are looking at" — where a toggle is a switch you threw. The rail's
   * drawer rows and the app rail's squares deliberately read differently for
   * exactly this reason (`principles.md` → The app rail).
   *
   * A prop rather than a className for the reason every state on these
   * primitives is one: a caller's plain `bg-…` loses to the resting
   * `hover:bg-…` at equal specificity, so a hand-painted selected row lost its
   * fill the moment a pointer touched it.
   */
  selected?: boolean
}

export const RowButton = React.forwardRef<HTMLButtonElement, RowButtonProps>(function RowButton(
  { className, density = 'row', variant = 'plain', selected, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      // Before the spread, so a caller that has a truer reading — `aria-selected`
      // on a listbox option, `aria-current="page"` on a nav row — still wins.
      aria-current={selected ? 'true' : undefined}
      // Everything else the caller passes lands on the button: `onContextMenu`,
      // `data-*` hooks a rail's roving focus and its tests select on, `role`,
      // `tabIndex`, `aria-expanded`. A row primitive that swallowed those is why
      // forty of these stayed raw elements.
      {...rest}
      className={[
        // No `justify-center`, no `font-medium`, no `gap-1.5`, no ramp height,
        // and no `.interactive` press scale: a full-width row that shrank 3%
        // under the pointer would visibly detach from the rows above and below
        // it. The press is the fill, which the row already has.
        'flex w-full items-center gap-2 text-left transition-colors',
        DENSITY[density],
        variant === 'dashed' ? 'border border-dashed border-[color:var(--border-default)]' : '',
        selected === true ? SELECTED : density === 'flush' ? RESTING_FLUSH : RESTING[variant],
        'disabled:cursor-not-allowed disabled:opacity-45',
        'aria-disabled:cursor-not-allowed aria-disabled:opacity-45',
        DENSITY_FOCUS[density],
        className ?? '',
      ].join(' ')}
    />
  )
})
