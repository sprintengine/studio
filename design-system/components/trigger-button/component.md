# Trigger button

The bordered control that **shows the current value and opens a surface to
change it**, where that surface is not a [select](../select/component.md).

The select already owns this chrome and owns it correctly. What it cannot do is
lend it out: a select renders a value *string* from a closed list of items, so
every trigger whose face is richer than a string — a glyph beside two lines, a
colour dot and a name, an avatar and a role, a chevron over a two-line box — had
to draw the chrome again. The consuming product had fifteen of those on
2026-09-08, and they had drifted on all four axes at once: `bg.surface` against
`bg.surface-raised`, a control's elevation against none, `font.size.body
font.weight.medium` against `font.size.meta`, `justify-content: center` against
`space-between`.

**Why it is not a button variant.** [button](../button/component.md)'s outline
variant is the nearest member and is deliberately not this. An outline button is
a control that *does* something, so it stands on the transparent `border.strong`
hairline of a tier 2 action and centres its label. A trigger is a **field**: it
states what the value is, on the field's own ground, the same one a select and
an input take. That is the whole distinction. It never carried the control
elevation the other members wore until 2026-10-04, and it takes none now.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Trigger | `.ds-trigger` | yes — a `<button>` |
| Value | `.ds-trigger-value` | yes — claims the width and truncates |
| Chevron | `.ds-trigger-chevron` | yes — `text.muted`, `aria-hidden` |
| Leading glyph | — | no — the caller's node, before the value |

The value slot is **children, not a string**. That is the one structural
difference from the select trigger and the reason this entry exists.

## Variants

- **Default** — `border.default` hairline over `bg.surface-raised`,
  `text.default` label, `size.control.sm` height. The same row as an input, so a
  trigger and a field in one form share a baseline.
- **`--dashed`** — the **empty** state: nothing has been picked yet. Dashed
  edge, transparent ground, `text.muted` ink. "Add a role", "Attach a file". It
  is the same dashed idiom [row-button](../row-button/component.md) uses for its
  create affordance, under the same condition: the control is a place for a
  thing that does not exist yet, and a solid edge would claim it already does.
- **`--content`** — the height comes from the children instead of the ramp, for
  the two-line trigger. A ramp step cannot serve it: the second line is what
  sets the box.
- **`--ghost`** (owner ruling 2026-10-04) — the trigger **inside a toolbar**: a
  workspace bar's panel picker, a panel header's branch picker. No edge and no
  ground at rest, `text.muted` ink; `bg.hover` and `text.primary` under the
  pointer; open, the `bg.selected` fill with no edge. Tier 3 of
  [button → Control tiers](../button/component.md): a control inside a surface
  has the surface for an edge, and a bordered field dropped into a row of ghost
  glyphs reads as a form that wandered into the chrome. In a form or a settings
  row a trigger stays on the default field chrome, beside the inputs it
  matches.

## States

| State | Treatment |
|---|---|
| Rest | `border.default`, `bg.surface-raised`, `text.default`. `--ghost`: no edge, no ground, `text.muted` |
| Hover | Border lifts to `border.strong`, ink to `text.primary`. Ground unchanged. `--ghost`: `bg.hover` and `text.primary` |
| Open | `border.strong` **and** the neutral `bg.selected` fill, `text.primary` ink, **held through hover**. `--ghost`: the same fill with no edge |
| Focus-visible | The shared ring |
| Disabled | 45% opacity, `not-allowed`, hover suppressed |
| Pressed | `scale(0.97)`, the press every control shares, removed under reduced motion |

**The open state is neutral.** An open popover is a *state*, not the view's
primary action, so it takes `bg.selected` like every other standing selection.
It is held through hover because a trigger that dimmed while its own surface was
showing would read as having closed it.

## Usage

- **Pair it with the surface it opens.** The component draws the open chrome;
  the caller still supplies `aria-expanded` and `aria-haspopup` from the popover
  it hosts. Drawn-as-open and announced-as-expanded are two facts, and a
  primitive that inferred one from the other would be guessing which surface the
  trigger controls.
- **Use `select` when the value really is one string from a closed list.** This
  is not a richer select; it is the same chrome for the case a select cannot
  render. Reaching for it where a select would do puts two shapes on one job.
- **Never add elevation.** If a trigger needs to be found on a busy surface, the
  surface has too much on it.
- **Inside a toolbar, take `--ghost`.** The field chrome is for a trigger that
  sits beside other fields.

## Accessibility

- The trigger owns `aria-haspopup`, `aria-expanded` and `aria-controls`; the
  surface owns its role and its accessible name. The consuming app's popover
  primitive supplies all three as trigger props.
- The chevron is decoration and is `aria-hidden`; the accessible name comes from
  the value and the field's own label.
- Focus returns to the trigger when the surface closes.

## Shipped implementation

`src/renderer/src/components/ui/TriggerButton.tsx`, exporting `TriggerButton`
with `variant`, `size` and `open`.
