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
| List | `.ds-check-row-list` | `--described` only — the surface the rows sit in: `border.subtle`, `radius.shell`, `bg.surface-raised`, hairlines between rows |
| Text | `.ds-check-row-text` | `--described` only — the two-line stack that replaces the single `-name` |
| Title | `.ds-check-row-title` | `--described` only — the name, at `font.weight.medium` on `text.primary` |
| Scope | `.ds-check-row-scope` | `--described`, optional — the mono name of what the row grants, `font.size.micro` on `text.subtle`, beside the title |
| Supporting | `.ds-check-row-supporting` | `--described` only — ONE line, `font.size.meta` on `text.muted` |

**Five elements at rest, under a recorded amendment.** `principles.md` caps a
repeated row at four, and this row spends five. The amendment is dated
2026-09-09 and lives beside the ceiling itself, not here: the ceiling counts
what a row *says*, and the fifth element here is a **control**, which answers in
16px a question the row would otherwise need a whole second surface for. Its two
conditions bind this row — the things it is *read* for still cap at four (glyph,
name, directory, trailing mark), and it reveals nothing on hover, because the
ceiling and the two-trailing-actions allowance are not additive.

So nothing else goes in: no second glyph, no chip, no revealed action. The
list's toolbar and the row's context menu are where actions live.

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

## Where the group bands sit — ruled 2026-09-09

A grouped list of check rows is **not** one listbox. It is one keyboard owner
holding **one listbox per group**, with the [group header](../group-header/component.md)
bands standing between them, outside every listbox.

This is a ruling because the two components were quietly contradicting each
other. This page says the list is one tab stop and the row's box is a drawing
so it cannot be the 401st; that page says its band carries a real `<button>`
chevron, the kit checkbox **whole**, and a trailing control in the tab order.
Both are right, and the Git panel's first spelling put the bands *inside* the
`role="listbox"` — which made every band three non-`option` children of a
listbox (`aria-required-children`, invalid) and turned a thirteen-file panel
into thirteen tab stops that were never meant to be one walk.

The shape that keeps both promises:

```
<div role="group" aria-label="Changed files" tabindex="0" aria-activedescendant="…">
  <div>                                    ← one per group, no role
    …group-header band: chevron, checkbox, overflow…   ← real controls, no listbox
    <div id="…-rows" hidden={collapsed}>   ← what aria-controls folds
      <div role="listbox" aria-multiselectable aria-label="Changes">
        <div role="option" …>              ← check rows, and nothing else
```

- **The outer element is `role="group"`, and it owns the walk.** `group`
  supports `aria-activedescendant`, so one cursor crosses every group: arrows
  step from the last row of one list into the first of the next, and Space and
  Enter keep working wherever the cursor is. A tab stop per group would make
  "walk the changes" a different gesture depending on how many changelists the
  person happens to have.
- **The rows' listbox owns `option`s and nothing else.** Anything that is not a
  row — a cap notice, an empty-group line, a footer — goes in the folded region
  *beside* the listbox, not inside it.
- **The band's controls are real, focusable controls.** That is the whole point
  of them being per-GROUP: a handful of tab stops buys the keyboard a real
  chevron and a real tri-state box, where per-ROW controls would have cost four
  hundred. The row's box stays a drawing for exactly the same reason.

An ungrouped flat list is unchanged: one `role="listbox"`, one tab stop, no
bands.

## Why a described row is a variant and not a new component

It is **the same row**: box beside name, box as a sibling, box never inside a
control, name leading and never the part that truncates. Every structural
claim this page makes still holds. What the variant changes is one thing — the
name is allowed a second line — and the base row already conceded that ground
in Usage: `min-height` is "the 24px hit-target floor, not a fixed height: a row
whose content grows is a row that grew, not a row that broke". A row that grows
is not a different row.

The temptation is to call it one, because it looks different at a glance: it is
taller, it wraps, it sits on a bordered surface. But a new component would have
to re-decide the box (sibling or descendant?), the name's flex behaviour, the
hover fill, the selection tiers, the disabled treatment and the focus ring —
and every one of those answers would be this page's, copied. That is exactly
how five surfaces came to draw five checkboxes. The test the system applies is
not "does it look different" but **"does anything about the row's structure
change"**, and here nothing does.

Two things it does NOT get, which is what keeps it a variant rather than a card:

- **One supporting line, never two.** A second line is a card, not a row.
- **No trailing slot, no glyph slot, no tree.** The described row's elements are
  box, title, scope, supporting — four, which is the repeated-row ceiling
  `principles.md` sets, with the box as the amendment's fifth *control*. The
  base row's glyph and trailing slots are unavailable here rather than merely
  unused: filling them would put six things on a row that already wraps.

**It takes the STANDALONE box spelling**, not the composite one. These rows come
in eights inside a dialog, not four hundreds inside a listbox: the kit checkbox
goes in whole, the row is the `<label>` that names it, and the row carries no
`aria-checked` because the input is the state. Eight tab stops is a keyboard
walk; four hundred is the reason the composite spelling exists at all.

## Variants

- **Default** — the flat list row: box, glyph, name, directory, trailing.
- **`--described`** — the same row with the **name allowed a second line**:
  a title, an optional mono scope name beside it, and one supporting sentence
  under both, inside a `.ds-check-row-list` surface whose rows are divided by
  hairlines. For a short set of consequential choices — the eight tailnet
  scopes on the pairing dialog — where the name alone does not say what
  granting it does. See the ruling below.
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
| Selected (focused pane) | `bg.selected` + a 2px inset `accent.primary` edge + `text.primary`. The edge reads through `--ds-selection-edge` (defaulting to the accent), so a host can neutralise it for the resting tier rather than owning two rules |
| Selected (resting pane) | `bg.selected-resting`, **no edge**, `text.default` |
| Cursored | `.ds-check-row-cursor` — a 2px `text.primary` mark in the leading gutter |
| Checked | `aria-checked="true"` — the box takes the accent fill and the tick |
| Mixed | `aria-checked="mixed"` — the accent fill and the dash. Mixed outranks checked |
| Disabled | `aria-disabled="true"`, `opacity: 0.5`, `not-allowed`. Stays in the walk |
| Described, rest | `bg.surface-raised` from the list beneath it, `text.primary` title, `text.muted` supporting, `text.subtle` scope |
| Described, hover | `bg.hover` across the whole row — the row is the label, so anything less would advertise a smaller target than the click has |
| Described, focus-visible | The row rings inward on the INPUT's `:focus-visible`, not the box's. Space toggles, natively, because the input is real |

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

**A described row's whole surface is the label.** The `<label>` wraps the box,
the title, the scope and the supporting line, so the click target is the row
and the accessible name is everything in it. Half-labelled rows — a label
around the title only, with the sentence outside it — are how a reader ends up
told "View workspaces" and never told what it lets in.

**The scope name is the same fact in the system's vocabulary**, said beside the
title rather than under it. It is smaller and quieter for that reason: the
title is the sentence a person reads, the mono name is what they would search
for or quote in an issue. A row whose mono name out-weighed its title would
have made the title decoration.

**Do not put anything interactive in the trailing slot**, and do not add a
hover-revealed action. At this density the reveal would be the fifth and sixth
elements, and the row would move under the pointer.

## Accessibility

- The row is a `<div role="option">` (a flat list) or `<div role="treeitem">`
  (a tree), never a `<button>` — so the box may sit inside it, and so the list
  can be one tab stop.
- **The list is one tab stop** — in a grouped list, the `role="group"` that
  holds the per-group listboxes is that stop (see the ruling above). It carries `tabindex="0"`, drives the row with
  `aria-activedescendant`, and each row carries a stable `id`. Arrow keys move
  the cursor, Space toggles the cursored row's `aria-checked`, and Enter opens.
- `aria-checked` is `true` / `false` / `"mixed"` and is the *only* announced
  form of the tick in composite mode; the drawn box is `aria-hidden`, so it is
  never met twice.
- Selection is `aria-selected`, which is a different question from
  `aria-checked` and must not be conflated: a person can stage a file they are
  not looking at, and look at a file they have not staged. An `option` always
  declares it — that is what a listbox is — while a `treeitem` declares it only
  when it *is* selected, because a tree emitting `aria-selected="false"` on
  every node announces itself as selectable even when nothing in it can be
  picked.
- **A described row is the standalone spelling and is announced by its input.**
  It is a `<label>` around a real `<input type="checkbox">`: the row is not an
  `option`, carries no `role` and no `aria-checked`, and needs none — the input
  is the state and the tab stop, Space toggles it natively, and the label's
  whole content (title, scope, supporting line) is its accessible name. The
  list around them is a plain `<ul>`, not a `listbox`: nothing roves, because
  every row is its own tab stop.
- **The described row's focus ring is the ROW's.** The input is the tab stop,
  but the label is the hit target, so ringing the 16px box inside a 44px row
  would mark the smallest part of what the person is operating. The ring is
  drawn inward, for the base row's reason — the row is full-bleed against a
  surface that clips an outset ring.
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

`src/renderer/src/components/ui/CheckRow.tsx`, exporting `CheckRow`. The box it
draws is `CheckboxBox` — [checkbox](../checkbox/component.md)'s own drawing,
exported from `ui/Checkbox.tsx` on 2026-09-09 so the decorative box and the
control are one picture rather than two.

**Not shipped: `.ds-check-row-body`.** The React primitive implements the
composite mode only, which is what both consuming surfaces need. The body
button is the framework-neutral spelling for the standalone case and is
specified here so a surface that needs it does not invent one; it grows a
primitive when a surface actually asks for it, not before.
