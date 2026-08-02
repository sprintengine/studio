import { LifecycleGlyph, type LifecycleState } from '../../components/ui'
import {
  SurfaceRail,
  type SurfaceRailFilter,
  type SurfaceRailRow,
  type SurfaceRailSearch,
} from '../../components/workspace/globalSurface/surfaceSubstrate'
import type { ReviewRailRow, ReviewRailStatus } from './reviewRailModel'

// The Reviews-door rail (MC-1708 T6, mockup §4): every walkthrough in this
// Multicode, whatever project the change belongs to, as a lifecycle glyph +
// title + state line — "Review a change" leads the rail (the entry point that
// replaced the retired review-workspace creation flow), then the search field
// with the project/status filter behind the filter glyph. The rail is owned by
// the surface (it lives inside GlobalSurfaceShell's rail slot), never the app
// sidebar.
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20): the list
// semantics and ↑/↓ + j/k keyboard navigation live once in the substrate.
// "Review a change" is itself a selectable state here (the create flow), so it
// rides the affordance's `selected` flag.

// The app's lifecycle vocabulary, not a tone dot: a draft is an empty ring, an
// in-progress review the (static) progress arc, a posted one the done disc.
const STATUS_GLYPH: Record<ReviewRailStatus, LifecycleState> = {
  draft: 'todo',
  'in-progress': 'in_progress',
  posted: 'done',
}

export interface ReviewsRailProps {
  rows: ReviewRailRow[]
  selectedReviewId: string | null
  newSelected: boolean
  search: SurfaceRailSearch
  filter?: SurfaceRailFilter
  onSelect: (reviewId: string) => void
  onNewReview: () => void
}

export function ReviewsRail({ rows, selectedReviewId, newSelected, search, filter, onSelect, onNewReview }: ReviewsRailProps): JSX.Element {
  const railRows: SurfaceRailRow[] = rows.map((row) => ({
    id: row.reviewId,
    title: row.title,
    stateLine: row.stateLine,
    tooltip: `${row.title} — ${row.dotLabel} · ${row.stateLine}`,
    icon: (
      <LifecycleGlyph
        state={STATUS_GLYPH[row.status]}
        live={false}
        label={row.dotLabel}
        className="shrink-0"
      />
    ),
  }))
  return (
    <SurfaceRail
      label="Reviews"
      rows={railRows}
      selectedId={newSelected ? null : selectedReviewId}
      onSelect={onSelect}
      newAffordance={{ label: 'Review a change', selected: newSelected, onActivate: onNewReview }}
      search={search}
      filter={filter}
    />
  )
}
