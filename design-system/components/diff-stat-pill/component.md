# Diff stat pill

How much a checkout has changed, as one small split pill: the added half in the
diff green on its wash, the removed half in the diff red on its wash, touching,
under one pill corner. Extracted from the shipped `DiffStatPill` primitive
(`src/renderer/src/components/ui/DiffStatPill.tsx`).

The caller decides the unit. The conversation strip counts **files** — "+3 −2"
is three files added or updated and two removed — because that is what a
checkout's summary answers; a surface showing one file's change would count
lines. The pill does not say which; the words in its name do.

## Anatomy

| Part         | Class                        | Required                                                                         |
| ------------ | ---------------------------- | -------------------------------------------------------------------------------- |
| Pill         | `.ds-diff-stat-pill`         | yes — one `control.xs`-high box, `radius.pill`, clipping its halves              |
| Added half   | `.ds-diff-stat-pill-added`   | when anything was added — "+N" in `color.diff.added` on `status.good-soft`       |
| Removed half | `.ds-diff-stat-pill-removed` | when anything was removed — "−M" in `color.diff.removed` on `status.danger-soft` |

The halves touch: no gap, no divider. The two washes meeting is the seam.

## Variants

- **Display** — a `role="img"` span naming the counts in words.
- **`--action`** — a button that opens what the counts are of (the Git panel,
  from the conversation strip). The pill is the button's whole surface, so it
  takes no ground of its own; hover draws a `border.strong` hairline on the
  pill's edge.

## States

| State                      | Treatment                                                    |
| -------------------------- | ------------------------------------------------------------ |
| Both counts                | Both halves, added first                                     |
| Only added                 | The added half alone, with the pill's whole corner — no "−0" |
| Only removed               | The removed half alone — no "+0"                             |
| Neither                    | **Not drawn.** A clean checkout is not a zero worth a pill   |
| Hover (`--action`)         | A `border.strong` hairline inside the edge                   |
| Focus-visible (`--action`) | The product focus ring                                       |

## Usage

**The diff channel's inks, never the status tones'.** An addition is not a
success and a deletion is not a failure; `color.diff.*` is the pair the diff
viewer draws its lines in, so a theme that tunes its diffs moves this pill with
them. The washes are the soft tints the diff viewer lays behind those same
inks.

**Numerals in the monospace family, tabular,** so a count that ticks from 9 to
10 grows the pill by one digit and nothing else moves.

**One line.** The pill never wraps and never shrinks; a row too narrow for it
moves it elsewhere (the conversation strip's "⋮" menu) rather than cutting it.

## Accessibility

- The halves are `aria-hidden`: "+3" and "−2" are glyphs, not words.
- The pill's name says the counts in words and, as a button, what it opens —
  "1 file added, 2 updated, 2 removed — open changes".
- Colour is never the whole message: each half carries its sign.
