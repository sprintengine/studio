# Board lane

The column chrome of a board: a header band naming the stage, a scrollable
list of task cards, and the drag-and-drop states a card moves through.
Extracted from the shipped `BoardLane` primitive
(`src/renderer/src/components/ui/BoardLane.tsx`).

The lane owns the column — its header rhythm, its scroll region, and its
drop states. It does **not** own the cards: children are `task-card`
components (already documented), and the card contract is unchanged inside a
lane. Use `list-row` when the items form a pick-one list; a lane is a stage
that work moves through.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Lane | `.ds-board-lane` | yes — a `<section>` with an `aria-label` |
| Header | `.ds-board-lane-header` | yes — one band: label left, count right |
| Glyph | `.ds-board-lane-glyph` | no — a lifecycle glyph beside the label, `aria-hidden` |
| Label | `.ds-board-lane-label` | yes — `font.size.meta` at `font.weight.emphasis`, `text.primary`, sentence case, truncates |
| Count | `.ds-board-lane-count` | yes — tabular, `font.size.micro`, `text.subtle` |
| Body | `.ds-board-lane-body` | yes — an `<ol>` of cards, the lane's scroll region |
| Drop indicator | `.ds-board-lane-drop` | during a drag — a 2px accent hairline `<li>` |

Lanes flex to fill the board row and shrink to a floor —
`--ds-board-lane-min-width`, 260px by default (a comfortable card width).
Past the floor the **board row** scrolls horizontally; **inside** the lane
only the body scrolls vertically. The header never scrolls away.

## Variants

- **Default** — transparent: the lane is a region of the board canvas, and
  hairlines between cards carry the structure.
- **`--surface`** — the lane is a filled, hairline-bordered panel
  (`bg.surface`, `radius.overlay`, `border.subtle`), and the cards inside
  lift one step to `bg.surface-raised` with an inset hairline. The inset
  hairline is load-bearing in light mode, where `bg.surface` and
  `bg.surface-raised` are deliberately the same white and the tone step does
  nothing. Opt in when columns must read as discrete panels; default off so
  a board canvas is not a grid of cards inside cards.

## States

Four drag states, and the lane is always in exactly one:

| State | Treatment |
|---|---|
| Default | No special chrome |
| `--dimmed` | `opacity: 0.4` — not a legal target for the dragged card |
| `--drop-target` | 1px accent ring — this lane will accept the card |
| `--source` | Neutral, same as default — the lane the card left |

The accent ring and the 2px drop indicator are the accent as ink marking a
genuinely live process — the one thing besides focus the accent budget lets
a hairline say. At rest a board shows no accent at all.

## Usage

**The header is one band.** Label and glyph on the left, count on the right,
nothing else. Lane-level actions belong in the board's own chrome or a
context menu — a button row per lane multiplies controls by column count.

**The count is the lane's canonical count.** Never restate it in the lane
(an empty-state line that says "0 items" under a header that says 0).

**Drop position is the card midpoint.** During a drag, the drop index is
found by comparing the pointer's y position with each card's vertical
midpoint; the consumer interleaves one drop indicator at that index. One
indicator on the whole board — it marks the place, not the possibilities.

**Reordering is the just-changed motion.** When cards move, they slide to
their new slots (a FLIP pass in the shipped primitive) composing
`motion.duration.normal` and `motion.ease.standard` — a pattern-owned
entrance, not a fourth motion. Reduced motion swaps the slide for an
immediate move; the reorder itself is never withheld.

**Drag is never the only path.** A pointer drag has no keyboard equivalent,
so every card move must also be reachable another way — a context-menu
"Move to…" or the detail pane. A board you cannot operate from the keyboard
is a bug, not a style.

**Empty is a state, not an absence.** An empty lane keeps its header and its
body height, and says what the emptiness means ("Nothing in review") —
otherwise an empty column and a failed load render identically.

## Accessibility

- Each lane is a `<section>` with an `aria-label` naming the stage
  ("In review lane"); the body is an `<ol>`, so assistive technology reports
  position in set for free.
- The lane label's glyph is `aria-hidden` — the label carries the meaning.
- The drop indicator is `aria-hidden`; the *result* of a drop is announced
  by the move's non-drag path, not by decoration.
- The dimmed state keeps its content readable — 0.4 opacity signals
  ineligibility during a drag that a pointer user is already mid-gesture on;
  it never carries information a keyboard user cannot get elsewhere.
- If the lane's body scrolls and must be keyboard-scrollable on its own,
  give it `tabindex="0"` and the inward focus ring, as `tabs` does for its
  panel. When every card inside is focusable, the cards themselves usually
  carry the scroll and the extra tab stop is noise — decide per surface.
