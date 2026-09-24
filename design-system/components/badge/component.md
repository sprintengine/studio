# Badge

**Status: shipped 2026-08-05** — `src/renderer/src/components/ui/`.

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
is counted ("Design: 2 new"), because the row beside it
names a place, not the news. The app rail's square above the drawer is the sum
of its rows: same primitive, same tone precedence, and the two cannot
disagree because one derivation feeds both (principles.md, "The app rail",
item 9).

**On a list row's mark** (2026-09-10) the same corner count is the row's own
pip: a plugin installed at a commit its source has moved past (and, until
2026-09-25, an agent CLI behind its published version — see "In Settings"
below for where that one went). The number is usually 1, and on a row that is
the point — a rail square's count is a quantity, a row's is a pointer, and the
number is what makes it a pip rather than one more status colour. It **replaces
the row's health dot** rather than joining it (`provider-row`, "One status
idiom"): the owner opened a list of ten agent CLIs from an update notification
and could not tell which row it was about, because all ten dots were the same
green. Its ring is `bg.surface`, the ground those lists sit on, and its
accessible name carries the row's name and the version it is behind ("Codex —
update available: 0.153.4").

**On a tab** (2026-09-10) it is the same pip again, docked top-right of the tab
and counting what is waiting INSIDE: "3 updates available" before the tab is
opened, with a pip on each row underneath saying which. It is not the tab's
`count` — that is how many things the tab holds and rides beside the label in
the reading line; this is how many of them want the person, and it sits above
the words because it is not part of them. On a tab the count is docked by the
strip in reserved trailing padding rather than overhanging the way `--corner`
does, because a tab strip scrolls inside an overflow container that clips
anything hanging past the edge — and it needs no keyline there, since it covers
the band rather than a glyph.

**In Settings** (owner ruling 2026-09-25) the same count marks an update
waiting to be installed — an agent CLI behind its published release, or a newer
SprintEngine Studio — from wherever the person is, down to the control that
installs it:

| Where | Counts | Drawn as |
|---|---|---|
| The Settings gear at the app rail's foot | every outstanding update | `--corner`, ringed in `bg.canvas` like a rail square ("2 updates available") |
| General in the Settings nav | the app update | trailing the label, as a drawer row wears its count ("Update available") |
| Agents in the Settings nav | the CLI updates | trailing the label ("2 CLI updates available") |
| A machine's segment on the Agents switcher | that machine's CLI updates | trailing the segment's label (segmented-control, "Badged segment") |
| A CLI's row | that CLI | beside its **Update** button, not on the mark ("Codex — update available: 0.41.0") |

One derivation feeds all five, so the gear, the nav, the switcher and the rows
cannot disagree about how many there are. Every one is the **accent** tone —
plain news, the tone the rail gives news — and every one is named, so the
number is never the whole message and colour is never the only signal.

On the CLI row the count sits beside the button that answers it rather than on
the mark: the row wears one count, next to the one thing that clears it, and a
person who arrived from the gear follows the number to the action. It still
**replaces** the row's health dot (`provider-row`, "One status idiom").

The app update's count holds through every step update-service reports —
available, downloading, downloaded, installing — and through a download that
failed (the update is still there to take, and General's version row offers
Download again); it goes when the new build starts and reports nothing waiting.
General's count says which question is open: "Update available", then "Update
ready to install".

An update stops being counted when it installs, or when the person dismisses it
— Later or Dismiss on its toast (the toast entry, "Dismissing an update is
'not now'"). A dismissal names one version, so the next release is counted
again; and it takes only the badges — the Update button and the version line
stay, because the update is still there to take. A tab or nav row whose count
is showing names itself with the count in it ("Agents, 2 CLI updates
available"), the same call the tab strip makes: the count is a named live
region, and inside the button it would otherwise land in the name twice.

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
