import type { BacklogHighlightColor } from '../../utils/backlog'
import { getHighlightSwatch } from '../../utils/highlight'

// A Backlog row's left bar + background, in paint order. One seam for both row
// surfaces (the panel list and the door list) so the rule can't hold in one and
// drift in the other.
//
// Identity and selection answer different questions, and they used to collide.
// `resolveBacklogRowColor` earns a `litFill` for a hand-set highlight or for the
// row's epic identity hue, and that tint was painted *instead of* the selection
// fill: selecting such a row moved it by 1.06:1 where a plain row moves 1.27:1,
// and in grayscale it did not move at all — the selected row was
// indistinguishable from its neighbours.
//
// Selection outranks identity: `--bg-selected` composites over the identity
// tint rather than being overpainted by it, so a row steps by the same amount
// whatever colour it carries. This is paint order only — `litFill` keeps its
// meaning and `resolveBacklogRowColor`'s precedence is untouched. Identity keeps
// every channel that is not the selection's: the 3px left bar (drawn in both
// states), the epic chip, and the tint itself on each row the user has *not*
// picked, which is what makes an epic's members read as one block.
//
// Painting the token rather than a baked colour is also what lets a Backlog row
// honour the resting tier: on a pane that is not the one holding focus,
// assets/index.css rebinds `--bg-selected` on the row carrying the ARIA state.
//
// RULING 2026-08-05 (MC-2115) — the 3px bar stays, and it is not the banned one.
// `foundations/principles.md` rejects the LEFT TONE-BAR on sight: a coloured
// stripe standing in for a notice's tone, where the tone is then carried by
// colour alone and doubles the card's own border. This bar says something else
// entirely — it is a row's EPIC IDENTITY, a hue the user assigned, and it is
// never the only carrier of that identity (the epic chip names it in words, and
// the tint reads on every unselected member). Nothing about it is a notice: no
// tone vocabulary, no severity, nothing to recover from.
// Rejecting it would cost the one channel that makes an epic's members read as a
// block, and would buy nothing — so this is a ruling, not a debt.
// The `left-bar` axis in `components/ui/designSystemAxes.test.ts` carries the
// matching allow-marker; this comment is the reason it points at.
//
// RE-RULED 2026-09-02 (design-system audit) — the bar is dropped. `EpicColorDot`
// carries epic identity on the row, and selection is `--bg-selected` plus the
// title lift alone. The panel list (`panels/BacklogPanel.tsx`) and its skeleton
// no longer reserve a `border-l-[3px]`, the door list followed, and the New
// sprint dialog keeps only its own implied-child accent rule (a mockup ruling,
// not identity paint). This helper therefore paints background only.
export function backlogRowPaintClass({
  color,
  litFill,
  selected,
}: {
  color: BacklogHighlightColor | null
  litFill: boolean
  selected: boolean
}): string {
  const swatch = color ? getHighlightSwatch(color) : null
  if (selected) return 'bg-[color:var(--bg-selected)]'
  // Hover is a background change only, and it is deliberately allowed to win
  // over the resting tint: the pointer's feedback is the more urgent signal.
  return `${swatch && litFill ? `${swatch.dimBg} ` : ''}hover:bg-[color:var(--bg-hover)]`
}
