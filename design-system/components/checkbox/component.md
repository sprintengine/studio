# Checkbox

**Status: shipped 2026-08-05** — `src/renderer/src/components/ui/`.

The one-of-a-set form control: a value the person marks now and submits
later. The `switch` entry already draws the line — a switch commits
immediately, a checkbox belongs to a form. Five surfaces had each styled the
same `<input type="checkbox">` independently — 3px and 3.5px boxes, one on the
browser's `accent-color`, one with a hand-rolled ring whose `ring-offset-color`
was pinned to one surface's background and therefore wrong on any other, and
one with no focus treatment at all. The most complete of them — the
styled-peer control that motivated `FOCUS_RING_PEER_CLASS` — is what this
entry promotes: one token-backed control with a `radius.chip` box,
`accent.primary` checked fill, the shared focus ring, and a real `<label>`.

## Marker mode (2026-09-08)

The box is a rendered **fact**, not a control: a GFM task-list marker inside
rendered markdown, where the checked state comes from the document and toggling
it here would change nothing.

Three things follow, and each is why the marker is not simply a disabled
checkbox:

- **No `<label>` wrapper.** The marker sits inside a list item whose text is
  already the item. Wrapping that text in a label would make a whole paragraph a
  click target for a control that accepts no clicks, and would nest a label
  inside prose the markdown renderer owns. The wrapper drops to a `<span>`.
- **No change handler.** A controlled input with a checked state and no handler
  needs `readonly`; without it every rendered task list logs a warning per box.
- **Not `disabled`.** A disabled input is skipped by some assistive technology
  and announces as *unavailable*, which this is not. `aria-readonly` says the
  true thing: the state is real, and it is not yours to change here.

The **drawn box is unchanged** — same `radius.chip` box, same `accent.primary`
checked fill, same mark. A task list that invented its own tick is exactly how
five surfaces came to draw five checkboxes.

## Shipped implementation

`src/renderer/src/components/ui/Checkbox.tsx`, exporting `Checkbox` with
`indeterminate`, `size` and `readOnly`.

## Radio mark (2026-10-08)

`RadioMark`, exported beside `CheckboxBox`: the box's single-answer twin. Same
`icon.size.sm` square, same `border.default` edge on the `bg.app` well, same
`accent.primary` fill once chosen — fully round (`radius.pill`), with a disc
where the tick would be. A question's choose-one rows had drawn their own, and
a round mark hand-rolled outside the system is a status dot by another name.

**Anatomy.** One round well; when checked, the accent fill and a disc in
`text.on-accent`. No input.

**States.** Unchecked, checked, and disabled (the box's 45% fade).

**Usage.** Only as the picture of a choice another element owns: a row with
`role="radio"` in a `radiogroup`, which is the tab stop and carries
`aria-checked`. There is no radio control in the kit. A value picked from a
closed list is a [select](../select/component.md) or a segmented control; a
choose-many list of rows takes `CheckboxBox`.

**Accessibility.** Always `aria-hidden`. The row announces the state; the mark
is only its picture and must never be met twice.
