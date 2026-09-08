# Badge

**Status: shipped 2026-08-05** (MC-2117) — `src/renderer/src/components/ui/`.

The small display-only label or count chip: a tone-carrying word ("draft",
"merged") or a number docked on a row or a control. "Badge" appears across
10+ files today (`BacklogRow`, `WorkspaceActions`, `PanelSwitches`,
`ThirdPartyModuleList`, `NotificationsPopover`, …) as ad-hoc rounded spans,
with count-badge styling reinvented per surface. This entry replaces those
with one primitive: `font.size.micro`/`meta` type on `radius.chip`, tones
drawn from the `status.*-soft` fills with their matching ink, never
interactive, and never a second status idiom beside a status dot that already
says the same thing.

## As shipped

Two species under one name, because the audit found two:

| | Shape | Fill | Ink |
|---|---|---|---|
| **Count** | circle at one digit, pill beyond | solid `tone.*` | `text.on-accent` |
| **Label** | pill | `tone.*-soft` with a `tone.*` hairline | `text.muted` |

`tabular-nums` on counts, so 1 → 2 does not jog the row. A `max` caps the
number ("99+") rather than letting the badge widen past its trigger.

**Ruling — radius is `pill`, not `radius.chip`.** The intent above said
`radius.chip` (3px); every badge actually shipping is `rounded-full`, and a
one-digit counter has to be a circle for the docked corner position to read as
a badge rather than a clipped square. `radius.chip` is the right token for a
*rectangular* chip; this is not one.

**Ruling — a count's ink is `text.on-accent`, not `bg.app`.** All three shipped
counters hardcoded `bg.app` as their foreground, which is only legible while the
badge sits on a saturated tone. `text.on-accent` is the token that means
"foreground for a filled surface" and holds on every theme.

**Corner mode** docks the badge to the top-right of a positioned trigger with a
1px border in the surface behind it, so it reads as sitting *on* the control. A
box-shadow ring would hold the box at exactly 16px, but the token lint's
`no-glow-shadow` rule forbids that spelling — and every counter this replaces
already used a border.

Never interactive, and never a second status idiom beside a `status-dot` that
already says the same thing. A badge carrying meaning takes an `ariaLabel` (a
bare "3" tells a screen reader nothing); one that merely repeats adjacent text
is marked `decorative` so it is not read twice.

**On the app rail** (2026-09-07) the corner count reports unread activity: each
section square wears the number of things in its area the person has not seen
or that are waiting on them (principles.md, "The app rail", item 8). It is
named, never decorative — nothing beside a glyph says what the number is — and
its ring is the rail's own `bg.canvas`, since the square sits on the canvas
rather than the app ground the default ring assumes.

**On a drawer row** (2026-09-08) the same counter is the row's unread pip: the
Extensions drawer's rows each wear the news that belongs to them, trailing the
label when the column is expanded and docked on the icon's corner — ringed in
`bg.canvas`, the column's ground — when it is collapsed. It replaces the row's
status dot while it shows (one status idiom per surface; the count is the one
that says how much), and its accessible name carries the row's name and what
is counted ("Sprints: 1 waiting on you, 2 new"), because the row beside it
names a place, not the news. The app rail's square above the drawer is the sum
of its rows: same primitive, same tone precedence, and the two cannot
disagree because one derivation feeds both (principles.md, "The app rail",
item 9).

## Only a count is a live region (2026-09-02)

The two species announce differently, and this is the part a consumer gets
wrong in both directions.

- **Count** — `role="status"`, so a value changing in place beside its trigger
  (the attention bell) is announced. This is what an announcement is *for*: the
  number moved while the reader was elsewhere.
- **Label** — never a live region. `role="img"` when it carries an `ariaLabel`
  (a bare `<span>` has no role for the name to hang on), plain text otherwise.

The audit found the label species emitting `role="status"`, which turned a
hundred-row skill listing into a hundred polite live regions that re-announced
every time the list narrowed. The fix belongs here rather than at the call
sites: marking those chips `decorative` would have silenced them, and
`decorative` means "the adjacent text already says this" — it is not a mute
button. Used as one it hides a fact nothing else states, which the same audit
found at three settings rows whose chip was the only thing saying a module was
unavailable or that a row was a skill rather than a server.

## The New mark (2026-09-08)

A third, narrower drawing under the same name: a pill saying a thing **arrived
recently**. `accent.primary` ink on `accent.primary-soft`, `font.size.micro` at
medium weight, `radius.pill`, and — the part that separates it from the label
species — **no hairline**. A border would make it read as a state chip, and this
is not a state: it is the system pointing at something, which is the one job
`accent.primary` has. It is the entire accent spend on the row that carries it.

Three surfaces wear it and they must not diverge, which is why it is one
shipped component (`src/renderer/src/components/ui/NewChip.tsx`) rather than a
span in each: the CLI model picker marks a model the hosted feed released
inside its thirty-day window, the Design door marks a component, pattern, glyph
or foundations file that arrived in a bundle since the person last opened it,
and (2026-09-08) the Extensions home marks a hosted card published since the
home was last open — the cards the app rail's square was counting, still
marked when the person arrives. The window is literally the same constant.

- **Never a hoist and never a sort key.** The row stays exactly where its list
  put it; the chip is the only difference, so a muscle-memory pick still lands.
- **It expires.** Both consumers stop drawing it on their own — the feed window
  passes, or the visit is stamped and the next open is clean. A mark that never
  clears is decoration.
- **It is plain text in reading order**, immediately after the name it
  qualifies, so a screen reader hears "command-palette, New". Where the row's
  own accessible name is written by hand (a tile whose `aria-label` composes
  name and counts), the word is composed into that name too rather than left
  for a nested span to supply.
