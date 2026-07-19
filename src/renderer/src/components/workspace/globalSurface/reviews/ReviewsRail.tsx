import { StatusDot } from '../../../ui/StatusDot'
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
      <div className="px-1.5 pb-1 pt-0.5 text-[11px] font-medium text-[color:var(--text-subtle)]">Reviews</div>
      {rows.map((row) => {
        const selected = !newSelected && row.reviewId === selectedReviewId
        return (
          <button
            key={row.reviewId}
            type="button"
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(row.reviewId)}
            className={`flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors ${
              selected
                ? 'bg-[color:var(--bg-active)]'
                : 'hover:bg-[color:var(--bg-hover)]'
            }`}
          >
            <StatusDot tone={row.tone} label={row.dotLabel} className="mt-[5px]" />
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate text-[12.5px] ${
                  selected ? 'font-medium text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
                }`}
              >
                {row.title}
              </span>
              <span className="block truncate text-[11px] text-[color:var(--text-subtle)]">{row.stateLine}</span>
            </span>
          </button>
        )
      })}
      <button
        type="button"
        aria-current={newSelected ? 'true' : undefined}
        onClick={onNewReview}
        className={`mt-1.5 flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] transition-colors ${
          newSelected
            ? 'bg-[color:var(--bg-active)] font-medium text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]'
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
