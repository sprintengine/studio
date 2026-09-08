# Toolbar

A band of icon controls that acts on the region directly beneath it, and
belongs to that region rather than to the pane around it.

The Git panel's glyph band is what it was drawn for (mockup 2522): refresh,
discard, move to changelist, stash, write commit message, show diff | group by,
expand all, collapse all — sitting between the pane's tabs and the changes
list's first row.

It **composes rather than restyles**. Every item is
[button](../button/component.md) `--icon`: a 26px square, borderless, a 16px
glyph, the shared focus ring, an accessible name. What this component owns is
the *band* — its height, its rhythm, its one hairline, and the divider that
groups the items inside it.

## The ruling this entry carries

`principles.md` caps **controls above the first content row of a panel at
five**, and this band has nine. That is not an exception this component grants
itself; it is an amendment to the ceiling, dated 2026-09-09 and recorded beside
the ceiling itself, and it is worth reading before adding a tenth item.

**The ceiling counts pane chrome, not a region's own header.** It exists
because chrome stacked above a region pushes the content down and makes a
person read a row of unrelated affordances before reaching what they came for
— which is a statement about a strip that belongs to the *window* and would be
there whatever the pane were showing. A band that belongs to **one** region,
acts only on that region, and would disappear with it is that region's own
header. The nine here are nine verbs about the changes list and nothing else:
hide the list and every one of them is meaningless.

Two conditions, both load-bearing:

1. **Every control acts on the region beneath it.** One item that opens a
   pane-level or app-level surface makes the band pane chrome again, and the
   ceiling of five applies to the whole thing.
2. **The band is grouped, not enumerated.** Nine identical squares in a row is
   a search problem; the divider is what turns it into "six about the files,
   three about the view". A band that needs a *third* group probably needs an
   overflow menu instead.

Unchanged: two stacked bands of chrome above one region is still a reject on
sight. The ruling is that this band is not chrome — not that a pane may have
two chrome strips.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Band | `.ds-toolbar` | yes — `role="toolbar"` with an `aria-label` naming what it acts on |
| Item | `.ds-button.ds-button--icon` | yes — the button component's icon variant, unchanged |
| Menu item | `.ds-toolbar-item--menu` | no — an item that opens a menu rather than acting |
| Divider | `.ds-toolbar-divider` | no — the system's first vertical divider, `aria-hidden` |
| Spacer | `.ds-toolbar-spacer` | no — pushes what follows to the trailing end |

Geometry: `size.control.sm` (30px) tall, `space.3xs` between items,
`space.xs` of inline padding, and one `border.subtle` hairline along the bottom.

## Variants

- **Default** — the bottom hairline. The band's whole separation: no fill, no
  shadow, no second rule above it. A toolbar that painted its own ground would
  read as a second surface stacked on the pane.
- **`--borderless`** — for a band that already sits under a hairline (directly
  beneath a tab strip or a `panel-header`, which draw their own). Two rules 30px
  apart is a ladder, not a structure.

## The vertical divider

The system's **first** vertical divider, and it earns being one: a band of
identical 26px squares has no other way to say "these six are about the files,
these three are about the view". A gap cannot — the items are already separated
by one, and doubling it reads as a rendering accident rather than a boundary.

Three decisions in it:

- **16px, not the band's full 30px.** A full-height rule meets the hairline
  below it and draws a corner, which is a table cell. This is a mark *inside*
  the band, not a wall across it.
- **`border.default`, not `border.subtle`.** It is the one thing in the band
  that has to be seen; `subtle` is the tone of a structure a reader is meant to
  read past.
- **Decorative.** A `<span aria-hidden="true">`, never an `<hr>` or a
  `role="separator"`. It separates nothing structurally: to a screen reader the
  band is one flat toolbar walked in order, and announcing a separator between
  item six and item seven describes a picture rather than a structure.

Do not use it as a general-purpose vertical rule elsewhere. Everywhere else in
the system, separation is space or a horizontal hairline.

## Menu items

An item that opens a menu rather than acting carries **a small filled corner in the bottom-right of the glyph's box**. Not a
chevron beside the glyph — that is a second mark on a 26px square, and it
pushes the glyph off centre.

The mark is decoration. `aria-haspopup="menu"` on the button is what says the
item opens something, and `aria-expanded` says whether it is open.

## States

Every state is the button component's, unchanged: `bg.hover` and an ink lift on
hover, the shared focus ring on `:focus-visible`, `opacity` and `not-allowed`
when disabled. This entry adds none of its own, deliberately — a toolbar item
that hovered differently from a button would be a second button.

**A disabled item stays in the band.** Which actions *exist* is information
even when one is unavailable, and removing it reflows the band under the
pointer that is reaching for its neighbour.

## Usage

- **The band's `aria-label` names the region, not the band**: "Changed files",
  not "Toolbar". A window with three toolbars must not present three landmarks
  called Toolbar.
- **Every item carries an `aria-label`.** An icon-only control with no name is
  a blank button — the one thing this shape can get wrong.
- **Tooltips, not native `title`.** Attach the `tooltip` component; a native
  `title` on a control is slow, ungoverned and unreachable by keyboard.
- **Order is leading cluster, divider, trailing cluster.** Where a band has a
  leading and a trailing group with space between, use `.ds-toolbar-spacer`
  rather than `justify-content: space-between`, which spreads three clusters
  when there are three.
- Do not put a labelled button, an input, or a select in this band. A control
  with words in it is a different height, a different rhythm, and the start of a
  form.

## Accessibility

- `role="toolbar"` on the band with a required `aria-label`.
- **The band is ONE tab stop, and arrow keys walk it.** That is what
  `role="toolbar"` promises: Left/Right (Home/End to the ends) move focus
  between items, exactly one item carries `tabindex="0"`, and Tab leaves the
  band. Nine separate tab stops between the tabs and the first file is the
  cost this role exists to remove.
- Disabled items keep their place in the walk when they carry `aria-disabled`;
  use the `disabled` attribute only where the reason needs no explanation.
- The divider is `aria-hidden`, and the corner menu mark is drawn in CSS, so
  neither is announced.
- Glyphs inside items are `aria-hidden`; the button's `aria-label` is the name.

## Shipped implementation

`src/renderer/src/components/ui/Toolbar.tsx`, exporting `Toolbar`,
`ToolbarButton`, `ToolbarDivider` and `ToolbarSpacer`.
