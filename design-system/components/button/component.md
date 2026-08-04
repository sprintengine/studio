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
- Sizes: default sm at `size.control.sm` and `ds-button--md` at
  `size.control.md`.

## States

- Hover: primary deepens/brightens to `accent.hover`; ghost and icon gain
  `bg.hover` and stronger ink. No shadow, scale, or glow on hover.
- Active: scale(0.97) press, removed under reduced motion.
- Focus-visible: 2px ring of `border.focus`; never remove the ring without
  replacing it.
- Disabled: 45% opacity, `not-allowed` cursor, hover suppressed.

## Usage

- One primary button per view; everything else is ghost or icon.
- Destructive confirmation buttons swap the fill to `status.danger` — do not
  invent a third neutral-filled variant.
- Keep labels to sentence case verbs ("Create workspace", not "CREATE").

## Accessibility

- Icon-only buttons require `aria-label`.
- Focus is always visible via the `border.focus` ring.
- The press animation is disabled under `prefers-reduced-motion: reduce`.
- Contrast: label-on-fill clears AA in both modes (`text.on-accent` flips
  between white and near-black with the mode).

## Known drift

Verified against `src/renderer/src/components/ui/Buttons.tsx` (2026-08-04).
Heights agree — both the reference CSS and the shipped code sit on
`size.control.*` — but three things ship that this spec does not say:

- **Label padding.** The reference CSS pads labels `0 var(--sem-space-lg)`
  (12px); shipped buttons use 8px (`px-2`) at sm and 12px (`px-3`) at md.
- **A `xs` size.** Shipped adds an undocumented dense-chrome step:
  `size.control.xs` height with a `font.size.meta` label.
- **`OutlineButton`.** A bordered neutral secondary the shipped kit made
  canonical. It is outlined, not a third *filled* variant, so it does not break
  the rule above — but it is system vocabulary this doc lacks.

MC-2113 standardizes the product on the shipped ramp and variants; MC-2118
owns reconciling this entry with that ruling.
