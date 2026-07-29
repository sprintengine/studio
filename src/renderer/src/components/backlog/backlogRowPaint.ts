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
// indistinguishable from its neighbours (docs/reviews/design-system-conformance-ui.md,
// F1).
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
  const bar = swatch ? swatch.border : 'border-l-transparent'
  if (selected) return `${bar} bg-[color:var(--bg-selected)]`
  // Hover is a background change only, and it is deliberately allowed to win
  // over the resting tint: the pointer's feedback is the more urgent signal.
  return `${bar}${swatch && litFill ? ` ${swatch.dimBg}` : ''} hover:bg-[color:var(--bg-hover)]`
}
