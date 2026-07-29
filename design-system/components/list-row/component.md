# List row

The pick-an-item worklist row: rails, source lists, inboxes, categories,
search results. The most repeated surface in the product, and the default
answer for any list of things a person chooses between.

Use `task-card` instead when the item is a card on a board. Use this when the
item is a row in a list.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Row | `.ds-list-row` | yes — renders as `<button>` when interactive |
| Leading mark | `.ds-list-row-leading` | no — a status glyph, type icon, or monogram |
| Text block | `.ds-list-row-text` | yes |
| Title | `.ds-list-row-title` | yes — the row's one priority, claims the width |
| Supporting line | `.ds-list-row-supporting` | no — one line, truncated |
| Identifier | `.ds-list-row-id` | no — mono, tabular, inside the supporting line |
| Trailing meta | `.ds-list-row-trailing` | no — display only, never interactive |
| Action host | `.ds-list-row-host` | only when the row has revealed actions |
| Action count | `data-actions` on the host | yes when there are actions — `"1"` or `"2"`, the value the trailing padding is reserved from |
| Actions | `.ds-list-row-actions` | no — at most two |
| Action | `.ds-list-row-action` | — |

At most **four visual elements at rest**. A fifth means the row is carrying
work that belongs in the detail pane.

## Variants

- **Default** — no modifier. The resting, unselected row.
- **`--selected`** — the selected row of the pane that currently has focus.
  Neutral `bg.selected` fill, title lifts to `text.primary`.
- **`--resting`** — the selected row of a pane that does not have focus.
  Quieter `bg.selected-resting` fill, title stays at `text.default`.

A surface has **exactly one `--selected` row on screen**. In a rail → list →
detail layout the other two panes use `--resting`, so the person can always see
which list their keyboard is driving.

Selection is never the accent colour, and never carries a left bar, a border
box, or a glow. See `patterns/selection`.

## States

| State | Treatment |
|---|---|
| Rest | Transparent background, `text.muted` |
| Hover | `bg.hover`, ink lifts to `text.default`. Background only — no shadow, scale, glow, or border that shifts geometry |
| Focus-visible | `focus.ring`, `outline: none`. Never on `:focus` — a mouse click must not draw a ring |
| Selected (focused pane) | `bg.selected` + `text.primary` |
| Selected (resting pane) | `bg.selected-resting` + `text.default` |
| Disabled | `opacity: 0.5`, `cursor: not-allowed`. Stays in layout and stays readable |

## Usage

**Actions are withheld until reached for.** Per-row actions — remove, reveal in
folder, roll back, close — live in `.ds-list-row-actions` and are invisible at
rest. They appear on hover and on keyboard focus. Ceiling: two. A third action
belongs in an overflow menu or the detail pane.

The row itself is the `<button>`, so an action cannot be nested inside it —
that is invalid HTML and breaks Safari and JAWS. Wrap the row and its actions
in `.ds-list-row-host` instead, which positions the actions over the row's
trailing padding. Declare `data-actions="1"` or `"2"` on that host: the actions
are positioned absolutely and reserve no width themselves, so the count is what
the row reserves its trailing padding from. Without it the text runs under the
icons. With it the space is held at rest, so revealing never reflows.

Do not put anything interactive in `.ds-list-row-trailing`. It is for a count,
a timestamp, or a status word.

Titles truncate to one line. If the full value matters, attach the system's
`tooltip` component, and only when the text actually overflows — never a native
`title` attribute on a control.

## Accessibility

- Interactive rows render as `<button type="button">`. A row that only displays
  information renders as a `<div>` and takes no focus.
- The selected row carries `aria-current="true"`. A single-select list may
  instead use `role="listbox"` with `role="option"` and `aria-selected`; pick
  one model and hold to it for the whole list.
- Every action button has an `aria-label` naming both the verb and the item
  ("Remove Engineering"), because the label is read out of the row's context.
- Leading glyphs are `aria-hidden="true"` when the title already carries the
  meaning.
- **Revealed actions must be keyboard-reachable.** They are in the tab order
  and become visible on `:focus-within` — an action that only exists on hover
  is unreachable for keyboard and touch users.
- Status shown by a leading glyph reads by shape, not colour alone, and carries
  an accessible name when no adjacent text states it.
- Disabled rows use the `disabled` attribute (or `aria-disabled="true"` when
  they must stay focusable to explain why).
- Reduced motion removes the reveal fade but never the reveal itself.
