import React from 'react'

import { FOCUS_RING_CLASS } from './tokens'

// The bordered POPOVER TRIGGER — the control that shows the current value and
// opens a surface to change it (design-system/components/trigger-button).
//
// `ui/Select` already owns this chrome, and owns it correctly: same height,
// radius, border, ground, hover border lift and focus ring. What it cannot do is
// lend it out. A `Select` renders a value STRING from a closed list of items, so
// every trigger whose face is richer than a string — a glyph beside two lines, a
// colour dot and a name, an avatar and a role, a chevron over a `min-h` box —
// hand-rolled the chrome instead. Fifteen of them, and they drifted on all four
// axes at once: `--bg-surface` against `--bg-surface-raised`, a control's
// elevation against none, `text-body font-medium` against `text-meta`,
// `justify-center` against `justify-between`.
//
// `OutlineButton` is the nearest kit member and is deliberately not this: it is
// a button that DOES something, on the transparent `border.strong` hairline of
// a standalone action, with its label centred. A trigger is a field: it says
// what the value is, on the field's own ground, and opens a surface to change
// it. That is the whole reason this is a separate member and not a variant of
// that one.

/**
 * - `field` (default) — the `Select` trigger's ground and border. What a
 *   labelled picker in a form or a settings row takes.
 * - `dashed` — the EMPTY state of the same trigger: nothing has been picked yet,
 *   so the edge is dashed and the ink is muted. "Add a role", "Attach a file".
 *   It is the same dashed-edge idiom `RowButton`'s `dashed` variant uses, and
 *   for the same reason: the control is a place for a thing that does not exist
 *   yet, and a solid edge would claim it already does.
 * - `ghost` — the trigger INSIDE A TOOLBAR (owner ruling 2026-10-04, tier 3):
 *   a workspace bar's panel picker. No edge and no ground at rest, muted ink,
 *   the hover fill every ghost control takes, and `meta` type like the chips
 *   and ghost buttons beside it. A bordered field dropped into a row of ghost
 *   glyphs reads as a form that wandered into the chrome. In a form or a
 *   settings row a trigger stays `field`.
 */
export type TriggerVariant = 'field' | 'dashed' | 'ghost'

/**
 * Height. `sm` is the ramp step an input and a select share, and is the default
 * because a trigger sitting in a form must be the same height as the field
 * beside it. `content` gives the height back to the children, for the two-line
 * trigger whose face is a glyph, a name and a supporting line — a case a ramp
 * step cannot serve, since the second line is what sets the box.
 */
export type TriggerSize = 'sm' | 'content'

const SIZE: Record<TriggerSize, string> = {
  sm: 'h-control-sm px-2',
  content: 'px-2 py-1.5',
}

// The resting chrome, per variant. Ground and border move together and each
// property is declared once per branch: a shared border plus a per-variant
// recolour would be two `border-*` utilities at equal specificity, settled by
// stylesheet order rather than by what the caller wrote.
const RESTING: Record<TriggerVariant, string> = {
  field:
    'border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] ' +
    'text-[color:var(--text-default)] ' +
    'hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:border-[color:var(--border-default)] disabled:hover:text-[color:var(--text-default)]',
  dashed:
    'border border-dashed border-[color:var(--border-default)] bg-transparent ' +
    'text-[color:var(--text-muted)] ' +
    'hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:border-[color:var(--border-default)] disabled:hover:text-[color:var(--text-muted)]',
  ghost:
    'bg-transparent text-[color:var(--text-muted)] ' +
    'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]',
}

// The type each variant sets. A field's label is body type, level with the
// input beside it; a ghost trigger's is the toolbar's meta, level with the
// chips and ghost buttons it sits among. One declaration per branch.
const TYPE: Record<TriggerVariant, string> = {
  field: 'text-body',
  dashed: 'text-body',
  ghost: 'text-meta font-medium',
}

// While the surface it opens is up. The neutral selection fill and the strong
// edge, held under the pointer — a trigger that dimmed while its own popover was
// open would read as having closed it. Never the accent: an open popover is a
// state, not the view's primary action.
const FIELD_OPEN =
  'border border-[color:var(--border-strong)] bg-[color:var(--bg-selected)] ' +
  'text-[color:var(--text-strong)] hover:border-[color:var(--border-strong)] ' +
  'disabled:hover:border-[color:var(--border-strong)]'

// A ghost trigger open takes the same neutral fill with no edge — the edge it
// never had at rest would be a border appearing — and holds it under the
// pointer, as the icon toggle beside it does when thrown.
const OPEN: Record<TriggerVariant, string> = {
  field: FIELD_OPEN,
  dashed: FIELD_OPEN,
  ghost:
    'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ' +
    'hover:bg-[color:var(--bg-selected)] disabled:hover:bg-[color:var(--bg-selected)]',
}

export type TriggerButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: TriggerVariant
  size?: TriggerSize
  /**
   * The surface this trigger opens is showing. Paints the open chrome; the
   * caller still passes `aria-expanded` (usually from `Popover`'s
   * `triggerProps`), because "drawn as open" and "announced as expanded" are two
   * facts and a primitive that inferred one from the other would be guessing at
   * which surface the trigger controls.
   */
  open?: boolean
}

export const TriggerButton = React.forwardRef<HTMLButtonElement, TriggerButtonProps>(function TriggerButton(
  { className, variant = 'field', size = 'sm', open, type, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      {...rest}
      className={[
        // `justify-between`, because a trigger's face is a value on one side
        // and a chevron on the other. No depth on any variant: see the header.
        'interactive inline-flex w-full items-center justify-between gap-2 rounded-sm',
        'text-left transition-colors',
        TYPE[variant],
        SIZE[size],
        open === true ? OPEN[variant] : RESTING[variant],
        'disabled:cursor-not-allowed disabled:opacity-45',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    >
      {children}
    </button>
  )
})
