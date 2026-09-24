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
| Count | the [badge](../badge/component.md) count species, inside a segment after its label | no — see "Badged segment" |

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
- `ds-segmented-control--icon-only` (2026-09-09) — square `size.control.xs`
  segments carrying a glyph at `icon.size.sm` instead of a word, and the label
  becomes the segment's `aria-label` **and** its tooltip. For a strip on a band
  that cannot spend width on labels: the diff window's side-by-side / unified
  toggle, which shares its row with the file stepper and the include counter.
  The square matches the `button --icon` items beside it in a
  [toolbar](../toolbar/component.md) band rather than standing a step taller.
  Every item must carry an icon.
- **Badged segment** (owner ruling 2026-09-25) — a segment may carry the
  badge component's count after its label, saying how much is waiting behind
  that choice: the Agents switcher's "1 CLI update available" on the machine
  that has it, and on no other. It trails the label inside the segment,
  `space.xs` after it, rather than docking on the corner the way `--corner`
  does, because the group clips its own edge to draw the rounded border and a
  corner count would be cut in half. Not on `--icon-only`: the square has no
  room beside the glyph. Nothing at zero. The count is news, not a second
  selection state — the selected fill stays the only thing that says which
  segment is chosen.
- **No accent variant.** The selected segment is a *selection*, and selection
  is neutral: `bg.selected` with the label lifted to `text.primary`. An
  accent-filled segment would spend the one solid accent on a state display.

## States

| State | Treatment |
|---|---|
| Selected | `bg.selected`, label at `text.primary`. Exactly one, always. On `--icon-only` the glyph takes the ink lift; the fill is the same |
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

- Labels are one or two words, sentence case, and a glyph is not a label. **One
  carve-out, added 2026-09-09** — the same one [tabs](../tabs/component.md)
  already carries: the `--icon-only` variant may draw the glyph *instead of* the
  word, and only because the word is still there. It becomes the segment's
  `aria-label` and its tooltip, so the name is one hover or one focus away and
  unchanged for assistive tech, and the accessible name is identical in both
  variants.

  What the line forbids is unchanged and is a different thing: a glyph
  **beside** a label, or a glyph standing in for a name that was never written.
  The condition is load-bearing — a segment with no label and no tooltip is a
  blank button, and it is the only thing this variant can get wrong. Reach for
  it only where the band genuinely cannot spend the width; two words are always
  more legible than two pictures.

  If a label needs truncation the control is overloaded.
- Segments get equal visual weight from the strip itself; do not stretch one
  segment wider to make it look primary. If one option is primary, the choice
  is not a segmented control.
- One strip per question. Two adjacent strips answering one question ("scope"
  split across two rows) is a select wearing two costumes.
- The group needs a visible label beside it (see the `field` component's
  standalone label) or an `aria-label`; the segment labels name options, not
  the question.
- **Which subject a settings page is about is a value it may set** (owner
  ruling 2026-09-24). Settings ▸ Agents lists one machine's agent CLIs, and the
  strip at its top picks the machine: the page, its sections and its controls
  stay the same page, only the machine they read and write changes, so it is
  not a tab strip in disguise. It shares the update channel's shape on
  purpose — one of a few named options, every one worth seeing. Picking changes
  nothing that is saved: arrowing across the strip asks each machine it lands
  on for its CLIs, which is a read, so selection-follows-focus stays a cheap and
  reversible choice. A page with a single subject draws no strip at all rather
  than a strip of one.

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
- A badged segment names itself with the count in it ("This PC, 1 CLI update
  available") as an explicit `aria-label`. The count is the badge's named live
  region, so it keeps announcing a change on its own, and the explicit name
  stops it from also landing in the segment's name-from-contents — the same
  call a badged tab makes.
- On `--icon-only`, the glyph is `aria-hidden` and the label moves to the
  segment's `aria-label`, so the accessible name is identical to the labelled
  variant's; the tooltip is the sighted user's version of that same string, and
  it opens on focus as well as hover.

## Known drift

~~Shipped `SegmentedControl.tsx` rounds the group at 6px (`rounded-md`) — a
radius that exists in no token — and pads md segments at 14px, a step the
space scale does not have. Token canon, which this entry specifies:
`radius.control` on the group and `space.lg` segment padding. The sm variant's
26px height is `size.control.xs` and is written as the literal in the source;
the token is the canon there too.~~ **Resolved 2026-09-02:** the group rounds
at `rounded-sm` (`radius.control`), md segments pad `px-3` (`space.lg`), and
the sm variant is `h-control-xs`. (`rounded-md` had by then come to mean
`radius.overlay`, 7px, in the app's `@theme` — the drift had grown by a pixel.)
