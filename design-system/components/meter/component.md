# Meter

How much of a known budget is spent, as a bar filled from the left. Extracted
from the shipped `Meter` primitive (`src/renderer/src/components/ui/Meter.tsx`).

It is a **display of one proportion**: not a control, and not a progress
indicator. Nothing is loading, and the value can fall as well as rise — a usage
window that resets goes back to nothing. Reach for it where the budget refills
on a schedule and several are read together, one under another: bars of one
length compare at a glance where rings do not. For the single "how full is the
context window" fact beside a title, the [context ring](../context-ring/component.md)
is the idiom; for something that completes, use a progress indicator.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Bar | `.ds-meter` | yes — the track, `bg.active` on a `border.default` inset hairline |
| Fill | `.ds-meter-fill` | yes — the spent share, `accent.primary` |
| Marker | `.ds-meter-marker` | no — a 2px tick at a second point the value is read against |

The value is the custom property `--ds-meter-value` (0–1) on the root, and the
marker's position is `--ds-meter-marker` (0–1). Both are per-instance data set
inline by the consumer, not design values.

The bar never carries its own label or number. The consumer says what is
measured and how much in its own type, beside the bar — "Weekly · 82% used ·
resets in 3d 4h" — because a bar alone makes the reader estimate a number they
could have been told.

## Variants

- **Default** — `accent.primary` fill.
- **`--warn`** — `status.warn` fill, at or past the consumer's warn threshold
  (90% of a usage window in the product that ships it), or when the budget is
  refusing work now. There is no danger tier: a full window is a wait, not a
  failure.
- **`--unknown`** — the track alone, quieter, when there is no value to show
  (the window reset since it was read). The consumer says "reset" in words.
- **`--compact`** — 16 × 4px, for a mark inside another control (a strip's
  trigger). Decorative there: the control carries the accessible name.

**The marker as pace.** For a window that refills on a schedule, the marker
stands at the share of the window's *time* gone by. A fill past the marker is
running ahead of the window; short of it, there is room to spare. The consumer
says which in words ("ahead of pace"); the marker never stands alone.

## States

| State | Treatment |
|---|---|
| Ordinary | accent fill |
| Warn | status.warn fill |
| Unknown | track only, 60% opacity |

A meter is not interactive and has no hover, focus or disabled state. A meter
inside a control takes that control's states.

## Usage

- Pair every bar with its words: what it measures, the number, and — for a
  window — when it resets.
- Read meters in a column of equal widths. Two meters of different lengths
  cannot be compared by eye.
- Do not animate the fill. A reading that changed is a new fact, not a motion.
- Do not tint the track. A track with a colour reads as a second value.

## Accessibility

- A standalone meter is `role="meter"` with `aria-valuemin="0"`,
  `aria-valuemax="100"`, `aria-valuenow`, and an `aria-valuetext` that says the
  number in words ("82% used"). Its accessible name comes from the label beside
  it (`aria-labelledby`).
- A meter with no value (`--unknown`) omits `aria-valuenow` and says why in
  `aria-valuetext` ("Reset").
- A `--compact` meter inside a control is `aria-hidden`; the control's own
  name says the value.
- Colour is never the only signal: the warn tone always comes with the words
  that say the window is close to or at its limit.
