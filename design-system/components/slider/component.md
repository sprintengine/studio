# Slider

One value taken off a ramp of ordered, discrete stops — an effort level, a
verbosity, a retention window. The stops are the domain's own named values and
the control snaps between them; there is no continuous range in this system,
because there is no quantity in the product a person sets to an arbitrary
number.

Reach for it when the choice is **ordered and the order is the point**: the
ramp itself says that the stop on the right costs more than the stop on the
left, which a menu of the same words does not. When the options are unordered,
or the person needs to read a description of each, it is a select or radio
rows.

It is also not a segmented control. A segmented strip shows every label at
once and is capped at four; a slider shows a *position* and one value name, and
stays legible at six or eight stops where the strip has long since run out of
row. The other half of that trade is real: a slider makes the person move
through the ramp to read it, so a two-stop slider is a switch wearing a track.
Three stops is the floor.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Root | `.ds-slider` | yes — `role="slider"`, `tabindex="0"`, `aria-valuemin` / `aria-valuemax` / `aria-valuenow` / `aria-valuetext`, and a name |
| Track | `.ds-slider-track` | yes — `aria-hidden`; owns the groove and its hairline |
| Fill | `.ds-slider-fill` | yes — inside the track, from the leading end to the thumb's centre |
| Tick | `.ds-slider-tick` | one per stop — `aria-hidden`, positioned inside the track |
| Thumb | `.ds-slider-thumb` | yes — `aria-hidden`, a sibling of the track, positioned against the root |

Two custom properties carry the state, set by the consumer as inline styles
because they are per-instance data, not design values:
`--ds-slider-position` (0–1) on the root, and `--ds-slider-tick` (0–1) on each
tick. A tick past the thumb marks itself `data-reached="false"`; the root at
the leading stop marks itself `data-at-start="true"`.

The root is `size.control.xs` tall and insets `space.sm` — half the thumb — on
both sides, so the track ends exactly where the thumb's centre can reach. That
is what puts ticks, fill and thumb in one coordinate space; a track drawn edge
to edge leaves the first and last ticks somewhere the thumb never arrives.

There is no label part and no value part. The name is the consumer's own text
(`aria-labelledby`, or `aria-label` when the control is genuinely alone), and
**the consumer displays the current value's name beside or above the
control** — a position alone does not tell anyone what they just picked, and
`aria-valuetext` says it only to a screen reader.

## Variants

None. One height, one thumb, one accent.

A continuous variant is a rejected idea, not a missing one: a value with no
named stops has nothing to put in the value line above the control, and the
person is left reading a number they did not choose in units nobody named.
A vertical variant is rejected for the same kind of reason — the ramp reads
left-to-right as cheap-to-costly because that is how the rest of the product
reads, and a vertical one would need its own convention for which end is more.

## States

| State | Treatment |
|---|---|
| Rest | `bg.active` track with a `border.default` hairline, `accent.primary` fill, thumb in `text.on-accent` |
| Leading stop | Nothing filled; the thumb takes `text.muted`, a neutral ink for the neutral ground it is resting on |
| Ticks | `text.on-accent` at 55% where the fill has reached them, `text.disabled` past the thumb |
| Focus | the shared `focus.ring` outline at `focus.ring-offset`, on `:focus-visible` only |
| Disabled | `aria-disabled="true"`: 45% opacity, `not-allowed`, no keyboard or pointer response |

The fill is the one place this control spends the accent, and it spends it the
way the switch does — as the **state** of a setting, not as an action. The
accent budget in `foundations/principles.md` governs solid accent on the
primary *action*; a filled track is the same object as a thrown switch, and
the two controls are deliberately made of the same material so a person reads
them as one family.

The thumb follows the surface under it, which is why the leading stop is
called out. A thumb pinned to `text.on-accent` disappears against the neutral
track at position zero — dark ink on a dark groove in dark mode — and that is
the position a slider is in the moment it is first shown. It takes `text.muted`
there rather than the switch's full-strength `text.primary`: the leading stop
is the ramp at rest, and a full-strength thumb made the quietest state on the
control the loudest mark on it.

## Keyboard

The control is one tab stop and the value follows the keys.

- ArrowRight / ArrowUp move one stop up, ArrowLeft / ArrowDown one stop down.
  Neither wraps: a ramp has ends, and wrapping from the costliest stop to the
  cheapest is a value nobody meant to pick.
- Home selects the leading stop, End the trailing one.
- PageUp / PageDown move by a larger step on a long ramp; on a ramp of five or
  fewer stops they are the same as the arrows.

Like the segmented control, this applies values as it moves, so it is for
cheap, reversible settings only. A choice with side effects belongs where
focus and commitment are separate steps.

## Pointer

Pressing anywhere on the strip selects the nearest stop and starts a drag;
the value snaps stop to stop while the pointer moves, and the press releases
wherever it is let go. The whole `size.control.xs` strip is the target, not
the 8px groove — a 6px-tall hit area is a control that has to be aimed at.

## Usage

- Three stops or more. Two is a switch; one is a label.
- The value's name goes next to the control, in the consumer's own type. Stop
  labels *under* the track are a rejected layout: they cannot fit past four
  short words, and they force a truncation the position was supposed to avoid.
- Put the cheap, safe, or small end on the left. Every ramp in the product
  reads the same direction, and a reversed one is read wrong before it is read
  at all.
- One slider per question, and never a slider beside a select answering the
  same question in a second shape.

## Accessibility

- `role="slider"` on a real focusable element with `aria-valuemin`,
  `aria-valuemax`, `aria-valuenow` — indices into the ramp, not the values
  themselves — and `aria-valuetext` carrying the current stop's **name**, which
  is the thing the person actually chose. Without `valuetext` a screen reader
  announces "3", which is not a level anyone selected.
- `aria-orientation="horizontal"` is the default and is stated anyway, because
  the arrow-key mapping depends on it.
- The root carries the name; the track, fill, ticks and thumb are all
  `aria-hidden` — they are one control's parts, and announcing them makes the
  control read as five things.
- Never an interactive descendant. A focusable tick inside a `slider` breaks
  the role's contract and puts a second tab stop where a person expects one.
- Disabled is `aria-disabled="true"`, not the removal of the tab stop: which
  stops exist is information even when the ramp cannot be moved.
- The value survives greyscale — the thumb's position, not the fill's hue,
  is what states it.
