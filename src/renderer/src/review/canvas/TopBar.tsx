import type { DiffView } from '../../../../shared/review'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { GhostButton } from '../../components/ui/Buttons'
import type { StatsChip } from './reviewSelectors'

interface TopBarProps {
  title: string
  source: string
  stats: StatsChip
  // Absent when no guide judged the change — the degraded model states no
  // complexity rather than inventing one (MC-1815). The signal is then simply not
  // on the bar; nothing renders in its place.
  complexity?: 'low' | 'medium' | 'high'
  diffView: DiffView
  onSetDiffView: (view: DiffView) => void
  onRerun: () => void
  rerunning: boolean
  // "Your review · N" and "Ask the guide" — present only when the container wires
  // comments / chat (the pure T7 harness omits them, so the buttons don't show).
  reviewCount?: number
  onOpenReview?: () => void
  onOpenChat?: () => void
}

const DIFF_VIEW_ITEMS: { value: DiffView; label: string }[] = [
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'inline', label: 'Inline' },
]

// The top bar, at the shared header height: change identity on the left, then
// the reading-effort and stats signals, the persisted view toggle, and Re-run.
// Complexity is a word, never a color — it signals reading effort without
// competing for the accent.
export function TopBar({
  title,
  source,
  stats,
  complexity,
  diffView,
  onSetDiffView,
  onRerun,
  rerunning,
  reviewCount,
  onOpenReview,
  onOpenChat,
}: TopBarProps) {
  return (
    // Geometry and type are `ui/PanelHeader`'s — `px-3 py-2` over
    // `--border-default`, title at `text-body font-semibold` — so the review
    // canvas opens at the same height as every panel beside it. It sat at
    // `h-[46px] px-4` under a `text-heading` title (2112).
    //
    // NOT the primitive itself, deliberately. PanelHeader carries one action
    // plus an overflow menu; this bar carries a view toggle and four controls,
    // and one of them — "Your review" with its pending count in the accent — is
    // discoverable-without-opening-the-drawer by design (see below). Moving
    // that set into a kebab is a product decision about the review loop, not a
    // consequence of standardising a header, so the row keeps its control set
    // and takes only the anatomy.
    <div className="flex shrink-0 items-center gap-2.5 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
      <span className="shrink-0 text-body font-semibold text-[color:var(--text-strong)]">{title}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-[color:var(--text-subtle)]">{source}</span>
      <span className="shrink-0 rounded-[5px] border border-[color:var(--border-default)] px-2 py-0.5 font-mono text-micro tabular-nums text-[color:var(--text-muted)]">
        {stats.files} {stats.files === 1 ? 'file' : 'files'} · <span className="text-[color:var(--tone-good)]">+{stats.additions}</span>{' '}
        <span className="text-[color:var(--tone-error)]">−{stats.deletions}</span>
      </span>
      {complexity ? (
        <span className="shrink-0 text-meta text-[color:var(--text-subtle)]">
          Complexity <span className="text-[color:var(--text-muted)]">{complexity}</span>
        </span>
      ) : null}
      <SegmentedControl
        ariaLabel="Diff view"
        items={DIFF_VIEW_ITEMS}
        value={diffView}
        onChange={onSetDiffView}
        className="shrink-0"
      />
      {onOpenChat ? (
        <GhostButton onClick={onOpenChat} className="shrink-0">
          <svg viewBox="0 0 16 16" className="icon-sm text-[color:var(--accent-primary)]" fill="currentColor" aria-hidden="true">
            <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" />
          </svg>
          Ask the guide
        </GhostButton>
      ) : null}
      {onOpenReview ? (
        (() => {
          // Pending comments give "Your review" an accent affordance so the loop's
          // payoff — post these to the PR — is discoverable without opening the
          // drawer: a soft accent fill plus the count in accent. Zero pending: the
          // plain ghost button, no competing accent.
          const pending = typeof reviewCount === 'number' && reviewCount > 0
          return (
            <GhostButton
              onClick={onOpenReview}
              className={`shrink-0${pending ? ' bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]' : ''}`}
            >
              Your review
              {pending ? (
                <span className="font-medium tabular-nums text-[color:var(--accent-primary)]"> · {reviewCount}</span>
              ) : null}
            </GhostButton>
          )
        })()
      ) : null}
      <GhostButton onClick={onRerun} disabled={rerunning} className="shrink-0">
        <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
          <path
            d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {rerunning ? 'Re-running…' : 'Re-run'}
      </GhostButton>
    </div>
  )
}

export default TopBar
