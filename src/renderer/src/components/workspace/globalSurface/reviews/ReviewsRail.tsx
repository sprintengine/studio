import { StatusDot } from '../../../ui/StatusDot'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import type { ReviewRailRow } from './reviewRailModel'

// The Reviews-door rail (MC-1708 T6, mockup §4): every walkthrough in this
// Multicode, whatever project the change belongs to, as a title + state line with
// a single status dot — then "Review a change" at the bottom, the entry point that
// replaced the retired review-workspace creation flow. The rail is owned by the
// surface (it lives inside GlobalSurfaceShell's rail slot), never the app sidebar.

export interface ReviewsRailProps {
  rows: ReviewRailRow[]
  selectedReviewId: string | null
  newSelected: boolean
  onSelect: (reviewId: string) => void
  onNewReview: () => void
}

export function ReviewsRail({ rows, selectedReviewId, newSelected, onSelect, onNewReview }: ReviewsRailProps): JSX.Element {
  return (
    <>
      <div className="px-2 pb-1.5 pt-0.5 text-[11px] font-semibold text-[color:var(--text-subtle)]">Reviews</div>
      {rows.map((row) => {
        const selected = !newSelected && row.reviewId === selectedReviewId
        return (
          <button
            key={row.reviewId}
            type="button"
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(row.reviewId)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
              selected
                ? 'bg-[color:var(--bg-selected)]'
                : 'hover:bg-[color:var(--bg-hover)]'
            }`}
          >
            <StatusDot tone={row.tone} size={7} label={row.dotLabel} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-[color:var(--text-strong)]">
                {row.title}
              </span>
              <span className="block truncate text-[10.5px] text-[color:var(--text-subtle)]">{row.stateLine}</span>
            </span>
          </button>
        )
      })}
      <button
        type="button"
        aria-current={newSelected ? 'true' : undefined}
        onClick={onNewReview}
        className={`mt-1.5 flex w-full items-center gap-2 rounded-md border border-dashed border-[color:var(--border-default)] px-2 py-1.5 text-left text-[12px] transition-colors ${FOCUS_RING_CLASS} ${
          newSelected
            ? 'bg-[color:var(--bg-selected)] font-medium text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
        }`}
      >
        <svg viewBox="0 0 16 16" className="icon-sm shrink-0" fill="none" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        Review a change
      </button>
    </>
  )
}
