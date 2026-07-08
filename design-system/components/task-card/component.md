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
- Selected: `accent.soft` fill plus a 2px left bar of `accent.primary`;
  title ink lifts to `text.primary`.
- Focus-visible: 2px `border.focus` ring.

## Usage

- The dot is a status signal, not decoration or category color; done/healthy
  rows usually carry no mark at all.
- Do not add a second interactive element inside the card; actions live in a
  context menu or the detail surface.
- Keep the trailing slot to short meta (relative age, a count).

## Accessibility

- The card exposes one accessible name combining identifier and title.
- Selection is conveyed with `aria-pressed` (or `aria-selected` in list
  semantics), not color alone — the left bar doubles as the non-color cue.
- Status dots are `aria-hidden` when adjacent text already carries the state;
  otherwise give them a `role="img"` label.
