# Segmented control

A bordered strip of mutually exclusive choices where every option stays
visible: 2–4 short labels of equal weight, one always selected. Extracted from
the source product's radiogroup strip
(`src/renderer/src/components/ui/SegmentedControl.tsx`).

It sets a **value**; it does not switch a view. A control that swaps the
content region below it is a tab strip — a different component with a
different role (`tablist`) and a different active treatment (the hairline
underline). And it is not a select: use one only when showing every option at
once is worth the row it costs, which stops being true past four options or
past one word per label.

Longer labels, or choices that need a hint sentence each, belong to radio
rows — the strip has no room for either, and cramming them in is the signal
you picked the wrong control.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Group | `.ds-segmented-control` | yes — `role="radiogroup"` with an accessible name; owns the border, radius, and overflow clip |
| Segment | `.ds-segmented-control-segment` | 2–4 — real `<button>`s with `role="radio"` |

The group owns everything structural. Segments are separated by a single
internal `border.subtle` hairline on each segment after the first — never a
doubled border, never a gap.

## Variants

- Default (no modifier) — `size.control.sm` height, `font.size.meta` labels at
  `font.weight.medium`. The form-control size: it shares a row height with
  inputs and selects.
- `ds-segmented-control--sm` — `size.control.xs` height, `font.size.micro`
  labels. The dense variant for an inline sub-control inside a compact
  popover; never the default on a form.
- **No accent variant.** The selected segment is a *selection*, and selection
  is neutral: `bg.selected` with the label lifted to `text.primary`. An
  accent-filled segment would spend the one solid accent on a state display.

## States

| State | Treatment |
|---|---|
| Selected | `bg.selected`, label at `text.primary`. Exactly one, always |
| Unselected | `bg.surface`, label at `text.muted` |
| Hover (unselected) | `bg.hover`, label lifts to `text.primary` |
| Focus | `focus.ring` outline on the segment, on `:focus-visible` only |
| Disabled segment | 45% opacity, `not-allowed`; skipped by arrow keys |

There is no empty state. A segmented control renders with a selection and
keeps one; "none of these" is itself a segment if the domain has it.

## Keyboard

The group is a **single tab stop**, and selection follows focus:

- Tab enters on the selected segment (it alone carries `tabindex="0"`; the
  rest are `-1`).
- ArrowRight / ArrowDown select the next enabled segment; ArrowLeft / ArrowUp
  the previous. Both wrap, both skip disabled segments, and focus moves with
  the selection.
- Click selects directly. Enter/Space need no handling beyond the native
  button activation.

Selection-follows-focus is the deliberate choice, and it is why the control is
restricted to cheap, reversible values: arrowing through the options *applies*
them. A choice with side effects (kicking off work, discarding state) must not
live here — it belongs in a select or radio rows, where focus and commitment
are separate steps.

## Usage

- Labels are one or two words, sentence case, no glyphs-as-labels. If a label
  needs truncation the control is overloaded.
- Segments get equal visual weight from the strip itself; do not stretch one
  segment wider to make it look primary. If one option is primary, the choice
  is not a segmented control.
- One strip per question. Two adjacent strips answering one question ("scope"
  split across two rows) is a select wearing two costumes.
- The group needs a visible label beside it (see the `field` component's
  standalone label) or an `aria-label`; the segment labels name options, not
  the question.

## Accessibility

- `role="radiogroup"` with `aria-label` (or `aria-labelledby`) on the group;
  `role="radio"` and `aria-checked` on each segment. Real `<button>`
  elements — never styled `<div>`s, never a hidden native radio hack that
  breaks the single-tab-stop contract.
- `aria-describedby` on the group is opt-in, for a visible line describing the
  selected option. Without one the group is named but undescribed — correct
  when the labels stand alone.
- Selection is conveyed by `aria-checked`, with the neutral fill and ink lift
  as its visual echo — it survives grayscale because the fill is a
  luminance step, not a hue.
- Disabled segments stay in the DOM and visible: which options *exist* is
  information even when one is unavailable.

## Known drift

Shipped `SegmentedControl.tsx` rounds the group at 6px (`rounded-md`) — a
radius that exists in no token — and pads md segments at 14px, a step the
space scale does not have. Token canon, which this entry specifies:
`radius.control` on the group and `space.lg` segment padding. The sm variant's
26px height is `size.control.xs` and is written as the literal in the source;
the token is the canon there too.
