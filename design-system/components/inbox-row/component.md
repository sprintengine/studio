# Inbox row

The queue row: a two-line item with a leading status mark, a title, one
supporting line, and a trailing timestamp or count. Extracted from the
shipped `InboxRow` and `InboxSearchInput` primitives
(`src/renderer/src/components/ui/InboxRow.tsx`, `InboxSearchInput.tsx`).

**When is a row an inbox-row and when is it a `list-row`?** A `list-row` is
the pick-an-item row: one line, the title claims the width, the supporting
clause shares its baseline, and per-row actions reveal on hover. An
inbox-row is the *triage* row: every item carries live state (the leading
mark), a summary worth its own line, and a freshness stamp — two stacked
lines, no action host. Rails, source lists, and settings lists are
list-rows; notification queues, attention inboxes, and run feeds are
inbox-rows. If the row needs revealed actions or fits on one line, it is a
list-row. The selection contract is identical in both.

The entry also specs the inbox surface's search field (`.ds-inbox-search`),
the second part of the `patterns/list-surface` anatomy these rows sit under.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Row | `.ds-inbox-row` | yes — a `<button>` when interactive, a `<div>` when display-only |
| Leading | `.ds-inbox-row-leading` | no — a `status-dot` (default) or a lifecycle glyph; one idiom per surface |
| Text block | `.ds-inbox-row-text` | yes |
| Title | `.ds-inbox-row-title` | yes — `font.size.body` at `font.weight.medium`, one line, truncates |
| Supporting | `.ds-inbox-row-supporting` | no — one line, `font.size.meta`, `text.muted`, truncates |
| Trailing | `.ds-inbox-row-trailing` | no — timestamp or count, tabular `font.size.micro`; display-only, never interactive |

Rows align to the top (`flex-start`), not the center: the leading mark
belongs to the first line, and a two-line row with a centered dot floats it
between the lines. Insets are `space.sm` block, `space.lg` inline.

Search field parts: `.ds-inbox-search` (the visible border box),
`.ds-inbox-search-glyph`, `.ds-inbox-search-input`, `.ds-inbox-search-clear`.

## Variants

- **Default** — the resting, unselected row.
- **`--selected`** — the selected row of the focused pane: neutral
  `bg.selected` fill, title lifts to `text.primary`.
- **`--resting`** — the selection a non-focused pane remembers:
  `bg.selected-resting`, title stays at `text.default`.

One `--selected` row per screen, as everywhere — see `patterns/selection`.

## States

| State | Treatment |
|---|---|
| Rest | Transparent, title at `text.default` — one real step below the selected title's lift |
| Hover | `bg.hover`, interactive rows only — and not on the selected row, whose fill already outranks it |
| Focus-visible | `focus.ring` |
| Selected / resting | As the variants above |
| Disabled | `opacity: 0.5`, `cursor: not-allowed`, stays in layout |

Search field: the wrapper draws the focus ring when the input inside it has
focus — the input is the tab stop, but the border box a person sees is the
wrapper. The clear affordance exists only while there is text to clear.

## Usage

**The ink lift needs headroom.** Unselected titles sit at `text.default`,
never `text.primary` — the lift to `text.primary` is selection's second
channel, and a list whose every title is already at full strength has
nothing left to lift.

**One status idiom.** The leading slot takes the system `status-dot` for
live state or a lifecycle glyph for worklist stages — whichever the surface
uses, uniformly. A row whose title already carries its state takes no mark
at all.

**Trailing is display-only.** The row itself is the `<button>`; nesting a
control inside it is invalid HTML. An inbox-row has no revealed-action host
— acting on an item happens in the detail pane it opens. A queue that needs
per-row actions is a list-row wearing the wrong clothes.

**The search field narrows the list it sits above.** It belongs to the
column, spans it, and the surface's one divider sits directly under its row
(`patterns/list-surface`). Escape with text in the field clears the text and
consumes the event — a hosting overlay must not also close on the same
press; Escape empty passes through.

## Accessibility

- Interactive rows are `<button type="button">`; display-only rows are
  `<div>`s and take no focus. The selected row carries `aria-current="true"`
  — which is also the hook a pane-scoping implementation keys the resting
  tier off.
- When the title node is not plain text, give the row an `aria-label`.
- Leading marks follow the `status-dot` contract: `aria-hidden` beside text
  that states the state, labelled otherwise.
- The search input carries a real `aria-label` ("Search inbox") — the
  placeholder is not a label. The clear button has its own ("Clear search").
- The wrapper's ring is keyed to the input's focus, not `:focus-within`:
  the clear button is a descendant with its own ring, and `:focus-within`
  would keep both painted at once.

## Drift ruling (2026-08-05)

**This spec won on both counts; the code moved.**

- **Title is `font.size.body` (13px).** It shipped at `meta`, the same step as
  its own supporting line — so the row's primary content read at exactly the
  size of the text explaining it, and the pair had no hierarchy at all. The
  same title/supporting pairing was ruled the same way for the door rails in
  the row-grid ruling, so the two row families now agree.
- **`InboxSearchInput` is `size.control.sm` (30px).** It shipped at `h-7`
  (28px), which is not a step on the control ramp (26/30/34) — a number from
  before the ramp existed.
- Shipped `InboxRow` implements the resting tier by pane cascade
  (`data-selection-pane` rules in `assets/index.css`) rather than this
  spec's `--resting` modifier — same rendered result, different mechanism.
  Framework rebuilds may keep either, provided exactly one pane renders the
  focused tier.
