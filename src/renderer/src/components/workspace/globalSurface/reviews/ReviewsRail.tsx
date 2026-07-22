import { SurfaceRail, type SurfaceRailRow } from '../surfaceSubstrate'
import type { ReviewRailRow } from './reviewRailModel'

// The Reviews-door rail (MC-1708 T6, mockup §4): every walkthrough in this
// Multicode, whatever project the change belongs to, as a title + state line with
// a single status dot — then "Review a change" at the bottom, the entry point that
// replaced the retired review-workspace creation flow. The rail is owned by the
// surface (it lives inside GlobalSurfaceShell's rail slot), never the app sidebar.
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20): the list
// semantics and ↑/↓ + j/k keyboard navigation live once in the substrate. "Review
// a change" is itself a selectable state here (the create flow), so it rides the
// affordance's `selected` flag.

export interface ReviewsRailProps {
  rows: ReviewRailRow[]
  selectedReviewId: string | null
  newSelected: boolean
  onSelect: (reviewId: string) => void
  onNewReview: () => void
}

export function ReviewsRail({ rows, selectedReviewId, newSelected, onSelect, onNewReview }: ReviewsRailProps): JSX.Element {
  const railRows: SurfaceRailRow[] = rows.map((row) => ({
    id: row.reviewId,
    title: row.title,
    stateLine: row.stateLine,
    tone: row.tone,
    dotLabel: row.dotLabel,
  }))
  return (
    <SurfaceRail
      label="Reviews"
      rows={railRows}
      selectedId={newSelected ? null : selectedReviewId}
      onSelect={onSelect}
      newAffordance={{ label: 'Review a change', selected: newSelected, onActivate: onNewReview }}
    />
  )
}
