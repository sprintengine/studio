// Human line-range label for an anchor, shared by the inline ribbon and the side
// panel summary cards so a single line range reads the same everywhere. Uses an
// en dash for spans and drops the range to a single line when start === end.

import type { ReviewAnchor } from '../../../../../shared/review'

export function anchorRangeLabel(anchor: ReviewAnchor): string {
  return anchor.startLine === anchor.endLine
    ? `L${anchor.startLine}`
    : `L${anchor.startLine}–${anchor.endLine}`
}
