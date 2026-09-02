# Button

Extracted from the source product's `PrimaryButton`, `GhostButton`, and
`IconButton` primitives. One accent rule applies: a view has at most one
primary button, and it shares its hue with selection chrome.

## Anatomy

- A single `<button>` element with the base class `ds-button` plus one
  variant modifier.
- Optional leading icon sized by `sem.icon.size.sm`, gap 6px.
- Label set in `font.size.body` at `font.weight.medium`, sentence case.

## Variants

- `ds-button--primary` — accent fill (`accent.primary`), `text.on-accent`
  label. The single primary action of a view.
- `ds-button--ghost` — transparent, `text.muted` label; hover lifts to
  `bg.hover` + `text.primary`. Secondary and tertiary actions.
- `ds-button--icon` — a `size.control.xs` square padded out to
  `size.hit-target-min`, borderless, icon-only. Must carry an `aria-label`.
  The canonical close affordance uses the `close` glyph.
- `ds-button--outline` — a bordered neutral secondary: `border.default`
  hairline, transparent fill, `text.default` label. Outlined rather than a
  third *filled* variant, so the one-accent rule still holds. Use it where a
  ghost reads too weak to be found but the action is not the view's primary.
- Sizes: `ds-button--xs` at `size.control.xs` with a `font.size.meta` label
  (dense chrome — toolbars, row actions), default sm at `size.control.sm`, and
  `ds-button--md` at `size.control.md`.

Label padding tracks the size rather than being constant: 8px at xs and sm,
12px at md. A single 12px inset makes a dense `xs` control read as mostly
padding.

## States

- Hover: primary deepens/brightens to `accent.hover`; ghost and icon gain
  `bg.hover` and stronger ink. No shadow, scale, or glow on hover.
- Active: scale(0.97) press, removed under reduced motion.
- Focus-visible: 2px ring of `border.focus`; never remove the ring without
  replacing it.
- Disabled: 45% opacity, `not-allowed` cursor, hover suppressed.
- Pressed (icon only): a toggle that stays thrown — a locked terminal, a
  revealed pane — fills `bg.selected` with `text.primary` ink and keeps it
  through hover. It is a **prop on the component**, not a class the caller
  adds: two equal-specificity `text-*` utilities are resolved by stylesheet
  order rather than by the order they appear in the attribute, so a call site
  that paints its own pressed fill loses it to the primitive's `hover:` step.
  The button supplies `aria-pressed` unless the caller sets it. Never the
  accent — a thrown toggle is a selection, and selection is neutral.

## Usage

- One primary button per view; everything else is ghost or icon.
- **A confirm/cancel pair is one rung apart, never the same rung twice.** Where
  the view's one primary is spent elsewhere, the affirmative takes `outline`
  and its counterpart drops to `ghost`. Two neutral outlines side by side —
  which is what an audit sweep produced for Approve/Deny in the agent chat —
  leave the two actions distinguishable only by reading the labels.
- Destructive confirmation buttons swap the fill to `status.danger` — do not
  invent a third neutral-filled variant.
- Keep labels to sentence case verbs ("Create workspace", not "CREATE").

## Accessibility

- Icon-only buttons require `aria-label`.
- Focus is always visible via the `border.focus` ring.
- The press animation is disabled under `prefers-reduced-motion: reduce`.
- Contrast: label-on-fill clears AA in both modes (`text.on-accent` flips
  between white and near-black with the mode).

## Drift ruling (MC-2118, 2026-08-05)

Reconciled against `src/renderer/src/components/ui/Buttons.tsx`. **The shipped
vocabulary wins on all three counts, and is now folded into the spec above
rather than listed as drift.**

- **Label padding** — 8px at xs/sm, 12px at md. The reference CSS's constant
  `0 var(--sem-space-lg)` predates the `xs` step; applied to a 26px control it
  is mostly padding.
- **`xs` size** — real, in use across dense chrome, and it has a token
  (`size.control.xs`). A ramp step the tokens already carry is not drift.
- **`OutlineButton`** — canonical. It is outlined rather than filled, so the
  one-accent rule is untouched.

Control **heights were never drift**: both the reference CSS and the shipped
code already sit on `size.control.*`. MC-2118's own drift table listed a
28/32px prose ramp against the tokens' 26/30/34 — that prose is not in this
entry, and the numbers here come from the tokens.

## Shipped implementation

`src/renderer/src/components/ui/Buttons.tsx`, exporting `PrimaryButton`,
`GhostButton`, `OutlineButton`, `IconButton` and `CloseIconButton` — the last
being the canonical close affordance named under Variants, exported separately
so no surface has to re-pick the glyph or the label.
