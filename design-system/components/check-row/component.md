# Check row

The pick-**and**-mark row, at the 24px hit-target floor: a file the person both
chooses and ticks. The Git changes list is the surface it was drawn for — the
tick *is* the index, checked means staged, mixed means partly staged — and the
File Explorer's tree is the same row with a chevron and an indent.

Two questions live on one 24px line, and the whole component is about keeping
them apart: **the tick is a value the row carries; the fill and the edge are
where the person is.** A row can be checked and unselected, selected and
unchecked, or both at once, and none of those four states may be mistaken for
another.

**Why neither existing row could be it.** [list-row](../list-row/component.md)
caps at four visual elements at rest, and this row spends five before it has
said anything — box, glyph, name, directory, trailing — and its row *is* the
`<button>`, which a checkbox may not sit inside. [row-button](../row-button/component.md)
owns no height at all, and the floor is the point here: four hundred files step
at one pitch or the list reads as noise.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Row | `.ds-check-row` | yes — a `<div>` with `role="option"` or `role="treeitem"`, never a `<button>` |
| Cursor | `.ds-check-row-cursor` | no — the keyboard cursor mark, `aria-hidden` |
| Twisty | `.ds-check-row-twisty` | `--tree` only — the disclosure chevron, `aria-hidden` |
| Twisty (leaf) | `.ds-check-row-twisty--leaf` | `--tree` only — the slot kept, the mark dropped |
| Check | `.ds-check-row-check` | yes — the 16px box slot, holding `components/checkbox`'s box |
| Glyph | `.ds-check-row-glyph` | yes — a reserved 16px slot, present whether or not it is filled |
| Name | `.ds-check-row-name` | yes — `flex: none`; never the part that truncates |
| Directory | `.ds-check-row-dir` | no — `text.muted`, takes the remaining width, truncates first |
| Trailing | `.ds-check-row-trailing` | no — display only: a status letter, a size, a count |
| Body | `.ds-check-row-body` | no — a `<button>` wrapping glyph/name/directory, for a row outside a composite widget |
| Depth | `--ds-check-row-depth` | `--tree` only — a unitless level, multiplying one `space.lg` step |

**Five elements at rest, and that is the ceiling this row is allowed.** The
four-element ceiling in `principles.md` is a rule about a row a person *reads*;
this row is one they *operate*, and the box is the operation. Nothing else goes
in: no second glyph, no chip, no revealed action. A row this dense has no room
to reveal anything — the list's toolbar and the row's context menu are where
actions live.

## The box is a sibling, never a descendant

A `<label>` cannot sit inside a `<button>`; that constraint is what shaped
`list-row`'s `-host` wrapper, where the actions are the row's sibling because
the row is the control. This row solves it upstream instead: **the row is a
`<div>` carrying an ARIA role**, so the box is simply one of its children,
beside the name rather than inside a control.

Two spellings, and what owns the state picks between them:

- **Composite (the default).** The row is an `option` or a `treeitem` inside a
  widget that is **one tab stop** and walks with `aria-activedescendant`. The
  box must not be the 401st tab stop, so it is drawn with the checkbox
  component's own box and marks, marked `aria-hidden`, and the row's
  `aria-checked` (`true` / `false` / `mixed`) is the announced state. Space
  toggles it; the list owns that key.
- **Standalone.** The row is not inside a composite widget — a handful of rows
  in a dialog, each independently reachable. The kit checkbox goes in whole,
  input and all, and the row carries no `aria-checked`: the input is the state.

The **drawing is the checkbox's in both cases**. What `component.css` restates
is only the two declarations that reveal the marked state, because CSS cannot
say "that rule, under a different condition" — the box's size, radius, border,
fill and ink all still come from [checkbox](../checkbox/component.md). A row
that drew its own tick is exactly how five surfaces came to draw five
checkboxes.

## Variants

- **Default** — the flat list row: box, glyph, name, directory, trailing.
- **`--tree`** — adds the chevron slot ahead of the box and a depth indent.
  The indent is a **unitless depth** (`--ds-check-row-depth: 2`) multiplying one
  `space.lg` step, not a pixel value, so a tree cannot drift off the scale one
  level at a time and a surface that wants a tighter tree changes one step
  rather than every row. Expansion is `aria-expanded` **on the row**, which is
  what a `treeitem` announces; the chevron is decoration, because a control
  inside the row would be a second tab stop per level.

## States

| State | Treatment |
|---|---|
| Rest | Transparent ground, `text.default` name, `text.muted` directory |
| Hover | `bg.hover`. Background only — no shadow, scale, or border that shifts the row |
| Focus-visible | `focus.ring`, drawn **inward**: the row is full-bleed against its list's edges, which clip an outset ring |
| Selected (focused pane) | `bg.selected` + a 2px inset `accent.primary` edge + `text.primary` |
| Selected (resting pane) | `bg.selected-resting`, **no edge**, `text.default` |
| Cursored | `.ds-check-row-cursor` — a 2px `text.primary` mark in the leading gutter |
| Checked | `aria-checked="true"` — the box takes the accent fill and the tick |
| Mixed | `aria-checked="mixed"` — the accent fill and the dash. Mixed outranks checked |
| Disabled | `aria-disabled="true"`, `opacity: 0.5`, `not-allowed`. Stays in the walk |

Every one of these is [list-row](../list-row/component.md)'s, verbatim and
deliberately. A second selection idiom on the row beside the rail would be a
second answer to "where am I", and the two channels this row already carries
(state and choice) is the most one 24px line can hold.

**Disabled is `aria-disabled`, never the attribute.** The row is an item in a
composite widget: it stays in the walk, and a person must be able to reach it
and be told why it cannot be ticked.

**The directory lifts one step on a selected row, and no further.** The mockup
lifted it to `text.primary` alongside the name; at that point the row's two
halves weigh the same and the filename stops being the thing you find.

## Usage

**The name does not flex.** It is what the person is scanning for, so it is
never the part that gets cut. The directory takes what is left and truncates
from the end, where a path is least informative. A name wider than the whole
row is clipped by the row rather than pushing the directory out of it.

**One row, one pitch.** `min-height` is the 24px hit-target floor, not a fixed
height: a row whose content grows is a row that grew, not a row that broke.
Two file lists at two pitches in one product is the defect this floor exists
to prevent.

**Two colour channels, never three** (`principles.md` → "Identity colour",
amended 2026-09-09). The glyph may wear its language's kind hue and the name
may wear a status tint, because the hue identifies and the tint grades — the
glyph is the same blue on a modified, added and deleted `.ts` row. Nothing
else in the row takes a colour, and interaction state paints over both.

**Do not put anything interactive in the trailing slot**, and do not add a
hover-revealed action. At this density the reveal would be the fifth and sixth
elements, and the row would move under the pointer.

## Accessibility

- The row is a `<div role="option">` (a flat list) or `<div role="treeitem">`
  (a tree), never a `<button>` — so the box may sit inside it, and so the list
  can be one tab stop.
- **The list is one tab stop.** It carries `tabindex="0"`, drives the row with
  `aria-activedescendant`, and each row carries a stable `id`. Arrow keys move
  the cursor, Space toggles the cursored row's `aria-checked`, and Enter opens.
- `aria-checked` is `true` / `false` / `"mixed"` and is the *only* announced
  form of the tick in composite mode; the drawn box is `aria-hidden`, so it is
  never met twice.
- Selection is `aria-selected`, which is a different question from
  `aria-checked` and must not be conflated: a person can stage a file they are
  not looking at, and look at a file they have not staged.
- A `treeitem` carries `aria-level`, and `aria-expanded` when it has children.
  A leaf declares neither `aria-expanded` nor a chevron mark, but keeps the
  chevron's slot.
- The glyph is `aria-hidden`; the name carries the meaning. Where the glyph's
  kind is information a person needs, it goes in the row's accessible name or
  a tooltip, not in the hue alone.
- The status tint on a name is never the only carrier of the status: the
  trailing slot's letter, or a visually-hidden clause, says "modified" in text.
- Reduced motion removes the ground transition and the chevron's rotation; it
  never removes the state change.

## Shipped implementation

`src/renderer/src/components/ui/CheckRow.tsx`, exporting `CheckRow`.
