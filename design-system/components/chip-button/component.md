# Chip button

A **content-height** pill that toggles, filters, or names one thing. A view-mode
segment on a canvas header, a zoom readout, a branch step in a wizard's trail, an
epic pill on a card, a "Debug" preset that throws a tinted ground.

**Why it is not a button size.** Every step of
[button](../button/component.md)'s ramp pins a `size.control.*` height, and a
chip's height is its **line box**. A chip sits inside a row that has already
decided how tall it is; a 26px control there sets the row's height instead of
riding it, and passing a block inset alongside does not fix it — the caller's
padding and the size step's height are different properties, and the height
wins. So the chip spends its size on the inset and the type, and on nothing else.

**Why it is not a [micro chip](../micro-chip/component.md).** That mark is
display-only and takes no state at all: it says something that was already true
before the person arrived. This is a **control**. If the mark would never react
to the pointer, it is a micro chip; if it toggles, filters, or navigates, it is
this.

**Why it is not a [segmented control](../segmented-control/component.md).** That
is a bar of mutually exclusive options sharing one track. Chips are individual —
they appear alone, in unlike company, and in numbers the bar could not hold.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Chip | `.ds-chip-button` | yes — a `<button>` |
| Variant | `--outline` / `--overlay` | no |
| Tone | `--warn` / `--error` | no |
| Leading mark | — | no — a colour dot, a glyph, sized by the caller |
| Label | — | yes, `font.size.micro`, sentence case |

`font.size.micro` and no lower. A chip is a label *about* the thing beside it,
and it must not outweigh what it qualifies.

## Variants

- **Default (ghost)** — no edge, no ground. A toggle in a chrome strip.
- **`--outline`** — a `border.default` hairline over `bg.surface-raised`. For a
  chip that must be findable on a busy surface: a wizard's branch step, a
  related-node chip on a canvas.
- **`--overlay`** — the form a chip takes when it **floats over content** rather
  than sitting in the flow: a canvas HUD control, a badge over a pan/zoom
  surface. `radius.overlay` and a `border.default` edge over `bg.surface`, so it
  reads as a small floating surface rather than as part of what is underneath.
  Still **no shadow**: the elevation ramp is for surfaces a person opened, not
  for chrome that was always there.

The edge, where a variant has one, is present **at rest and held through every
state**. A border that appeared when the chip was thrown would resize the row it
sits in.

## Tone

- **Default** — `text.subtle`, lifting to `text.default`. The chip is a
  qualifier.
- **`neutral`** — `text.default`, lifting to `text.primary`. One step up, where
  the chip's label is the row's own information.
- **`--warn` / `--error`** — a **standing warning the chip itself carries**:
  scripts are running in this preview, permissions are bypassed on this preset.
  Thrown, it fills the tone's soft tint and takes the tone's `on-tint` ink, which
  is what keeps the label legible on the fill.

The tone tints are the one narrow exception to "status is never a pill". The
condition is that the chip **is the control that sets the state** — the person
turned bypass on, and the chip is where they turn it off. A chip that merely
*reports* a state, beside a row that also carries a dot, is the badge/dot
collision the system rejects on sight.

## Identity tint

A chip may carry an **identity colour** of its own — an epic's hue, a bucket's —
resolved per item by the caller. It paints the ink and a 12% mix of the same
value as a ground, **never a solid fill**: an identity hue is a name, not a
status and not an emphasis (`principles.md` → Identity colour). It is the same
12% weight the `status.*-soft` tokens carry, so an epic pill and a warn chip sit
at the same depth on the surface.

A thrown state **outranks** the tint. Interaction state is a state of the pointer
and the keyboard; an identity is a property of the thing, and the state paints
over it while it lasts — the same ordering the file tree's row washes follow.

## States

| State | Treatment |
|---|---|
| Rest | Per variant and tone above |
| Hover | `bg.hover` ground, ink one step up — **only while not thrown** |
| Thrown | `bg.selected` (neutral tones) or the tone's soft tint, held through hover |
| Focus-visible | The shared ring |
| Disabled | 45% opacity, `not-allowed` |
| Pressed | `scale(0.97)` — flat controls press by scale |

## Accessibility

- **`aria-pressed` for a toggle, `aria-current` for one of a set.** A view-mode
  chip you switch on is pressed; the step you are on in a trail is current. Both
  are tri-state in the shipped implementation: undefined on a chip that is
  neither, `false` on a toggle that is off.
- The label carries the meaning; a chip whose state is colour alone fails
  grayscale. A thrown chip changes its **ground**, which survives it.
- Chips are individually focusable. A row of chips is a row of tab stops unless
  the host makes it a composite, in which case the host owns roving focus and the
  chips take `tabIndex` from it.

## Known drift

**The tone tints' ink.** The reference CSS here paints a thrown `--warn` /
`--error` chip in the tone's own colour on the tone's soft fill — the call
[badge](../badge/component.md) and [banner](../banner/component.md) already make
in this bundle. The shipped primitive darkens it one step, to an "on tint" ink
mixed toward `text.primary`, because the raw tone on a 20% tint of itself is
close to the contrast floor at `font.size.micro`.

That step exists in the consuming app and **has no token here yet**, so it is
recorded rather than invented locally: adding `status.*-on-tint` to the
foundations is a token decision with nineteen themes downstream of it, not a
component's to make. The shape, the fill and the condition are the same either
way.

## Shipped implementation

`src/renderer/src/components/ui/ChipButton.tsx`, exporting `ChipButton` with
`variant`, `tone`, `pressed`, `selected` and `tint`.
