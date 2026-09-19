# Task card

Extracted from the source product's `TaskCard` primitive — the canonical
board-card and inbox-row surface. Its family contract keeps every worklist
in the product reading as one system.

## Anatomy

- The card itself is the single interactive element (a `<button>` or a row
  with one click target) on `bg.surface` with a `border.subtle` hairline and
  `radius.control`.
- Leading: an optional 6px status dot (`ds-task-card-dot`). Status only —
  omit it when the surrounding column or text already states the status.
- Identifier: mono, tabular numerals, `font.size.meta`, `text.subtle`.
- Title: `font.size.body` at `font.weight.medium`, truncating to one line.
- Trailing: display-only meta (age, count) in `text.muted`; never
  interactive.

## Variants

- Row (shown): one line, identifier and title share the baseline.
- Card: identifier above the title, title clamps to two lines — same tokens,
  different stacking; rebuild per layout need.
- Dot tones: default neutral, `--good`, `--warn`, `--danger`.

## States

- Hover: `bg.hover` only — no shadow, scale, or glow.
- Selected (focused pane): `bg.selected` neutral fill, border lifts to
  `border.default`, title ink lifts to `text.primary`.
- Selected (resting pane): `bg.selected-resting`. A board that is not the
  focused pane shows its selection at this tier — see `patterns/selection`.
- Focus-visible: `focus.ring`.

Selection is neutral, never the accent, and carries no left bar. The accent is
reserved for the primary action.

## Usage

- The dot is a status signal, not decoration or category color; done/healthy
  rows usually carry no mark at all.
- Do not add a second interactive element inside the card; actions live in a
  context menu or the detail surface.
- Keep the trailing slot to short meta (relative age, a count).

## Accessibility

- The card exposes one accessible name combining identifier and title.
- Selection is conveyed with `aria-pressed` (or `aria-selected` in list
  semantics), never by the fill alone — assistive technology reads the state
  from the attribute, and the ink lift to `text.primary` carries it visually.
- Status dots are `aria-hidden` when adjacent text already carries the state;
  otherwise give them a `role="img"` label.

## Drift ruling (2026-08-05)

**This spec won on both counts; the code moved.**

- **Title is `font.size.body` (13px)**, not `meta`. A card's title is its
  primary content; at `meta` it sat level with the supporting line beneath it.
  Ruled together with `inbox-row` and the door rails so every
  title-over-supporting pair in the system uses the same two steps.
- **Identifier is `font.size.meta` in `text.subtle`**, in both variants. It
  shipped at `micro`, and — only on the card variant — in `text.muted`, so the
  same identifier changed weight depending on which variant happened to be
  showing it. One identifier, one treatment.
