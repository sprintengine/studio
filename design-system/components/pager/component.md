# Pager

The foot of a list that is walked one page at a time: the position said in
words on the left, the page controls on the right.

Use a pager when a list is longer than a person will scroll and its order
means something — a catalogue of 318 connectors kept in categories, a
repository's skills kept in folders. Use progressive disclosure ("Show N
more") only for a short tail inside one section. Use infinite scroll for a
feed, where position does not matter and there is no last page.

A pager exists because the toggle it replaces cannot state a position. "Show
25 more" grows the page without ever saying how much is left, it forgets
where you were the moment you leave, and three sections each expanded to a
different depth is a list with no position at all.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Root | `.ds-pager` | yes — `<nav>` with an `aria-label` naming what is paged |
| Range | `.ds-pager-range` | yes — the position in words, tabular, a polite live region |
| Controls | `.ds-pager-controls` | no — absent when there is only one page |
| Step | `.ds-pager-step` | yes (with controls) — previous, each page number, next |
| Elision | `.ds-pager-gap` | no — `…` standing for skipped numbers, `aria-hidden` |
| Icon | `.ds-pager-icon` | no — the chevrons, `icon.size.xs`, `aria-hidden` |
| Position | `.ds-pager-position` | `--inline` only — `n/m`, tabular, carrying the sentence as its accessible name |

Steps sit `size.control.sm` (30px) tall and at least that wide, spaced by
`space.3xs`, with `space.md` inline padding so a three-digit page still fits
its box. The row is separated from the list above it by `space.lg` of top
padding and nothing else — the list's own last row is the only edge it needs.

## Variants

There is one pager. What changes is how much of it is there:

- **Paged** — the range plus the controls.
- **Single page** — the range alone. The count is still news ("Showing 1–8 of
  8"); a strip of one number is not.
- **Empty** — the range says what is missing ("Nothing matches “stripe”", "No
  plugins here") and there are no controls. An empty list still gets its
  sentence, because the alternative is a blank region that reads as broken.

…and one modifier, for a pager that is not the foot of anything:

- **`--inline`** (2026-09-09) — the pager as a **stepper inside a band**:
  `n/m` in `tabular-nums` between two `size.control.xs` chevrons, sitting in a
  [toolbar](../toolbar/component.md) beside other controls. The diff window's
  file stepper is what it was drawn for — "2/27" between the hunk arrows and the
  view toggle.

  Three things go, all for the same reason (the band has no width to spend on
  them): the numbered strip, the words sentence, and the foot padding. The
  chevrons drop to `size.control.xs` so the stepper sits level with the
  `button --icon` items beside it rather than standing a step taller.

  **What does not go is the rule that makes a pager a pager.** The ends stay
  reachable, and the chevrons are *disabled* at them, never absent — removing
  them reflows the band under the pointer that is clicking them. And the
  sentence does not disappear: it moves to the position's **accessible name**,
  so a screen reader still hears "File 2 of 27" while the drawing shrinks to
  "2/27".

  Use it only where a foot does not exist. A list with a bottom edge gets the
  full pager; `n/m` in a band is a compression, and compressions are paid for.

## States

| State | Treatment |
|---|---|
| Rest | `text.muted` on a transparent ground |
| Hover | `bg.hover` and an ink lift to `text.primary` |
| Current page | `bg.selected` + `text.primary` + `font.weight.medium`, marked `aria-current="page"` |
| Focus-visible | `focus.ring` |
| Disabled | `opacity: 0.5`, `cursor: not-allowed` — previous on page 1, next on the last |
| Inline position | `.ds-pager-position` at `text.muted`, tabular. Never the accent: "where am I" is a state display |

## Usage

**The current page is neutral.** `bg.selected` plus an ink lift, exactly as a
selected segment. An accent-filled page number is a reject on sight: the
accent is the view's one primary action, and "which page am I on" is a state
display.

**The ends stay reachable.** Always draw page 1 and the last page, plus a
window around the current one, and elide the rest. The strip's width must not
grow with the source — a 27-page catalogue and a 3-page one draw the same
number of buttons. A single skipped page is drawn rather than elided: `1 … 3`
is wider than `1 2 3` and hides more.

**Previous and next are disabled, not absent.** Removing them at the ends
reflows the strip under the pointer that is clicking it.

**One pager per region.** It walks the whole region, groups included: a group
that does not fit continues onto the next page under a heading that says so.
Two pagers, or a pager per group, is a list with two positions.

**Say the position in words.** "Showing 13–24 of 318" is the whole point.
Numbers alone tell you where you can go, not where you are. `--inline` is the
one place the words are not *drawn*, and even there they are still said: the
sentence becomes the position's accessible name rather than being dropped.

**Paging replaces rows; it must not move focus.** The clicked page button
keeps focus, so the range sentence is a `role="status"` live region — that
announcement is the only signal a screen-reader user gets that the list
changed.

## Accessibility

- The root is `<nav>` with a required `aria-label` naming what is being paged
  ("Plugins in SprintEngine Studio"), so a page with several lists does not
  present several identical "pagination" landmarks.
- Page numbers are `<button>`s; the current one carries `aria-current="page"`
  and every one carries an `aria-label` ("Page 3") so the number is not read
  as a bare digit.
- Previous and next are `aria-label`led; their chevrons are `aria-hidden`.
- The elision is `aria-hidden` — it names no page.
- The range is `role="status" aria-live="polite"`, and it is the only live
  region in the pager. On `--inline` the position takes that role, and an
  `aria-label` carrying the full sentence — so the visible "2/27" and the
  announced "File 2 of 27" are one element, and there is still exactly one live
  region.
- Tab order is the natural one: the strip is a row of ordinary buttons, not a
  roving-tabindex composite. A pager is reached rarely and left immediately,
  so a person tabbing to page 4 should not first have to discover that arrow
  keys drive it.

## Shipped implementation

`src/renderer/src/components/ui/Pager.tsx`, exporting `Pager` (the row, with
an `inline` prop) and `pagerSteps` (which numbers to draw, given the page and
the count). What a
page CONTAINS is not the primitive's business: the consumer's own model slices
its groups and hands over `page`, `pageCount` and the range sentence. The
Extensions catalogues' model is
`src/renderer/src/components/workspace/globalSurface/extensions/catalogue/cataloguePaging.ts`.
