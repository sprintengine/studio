import type { DiffView } from '../../../../../shared/review'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { GhostButton } from '../../ui/Buttons'
import type { StatsChip } from './reviewSelectors'

interface TopBarProps {
  title: string
  source: string
  stats: StatsChip
  complexity: 'low' | 'medium' | 'high'
  diffView: DiffView
  onSetDiffView: (view: DiffView) => void
  onRerun: () => void
  rerunning: boolean
}

const DIFF_VIEW_ITEMS: { value: DiffView; label: string }[] = [
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'inline', label: 'Inline' },
]

// The 46px top bar: change identity on the left, then the reading-effort and
// stats signals, the persisted view toggle, and Re-run. Complexity is a word,
// never a color — it signals reading effort without competing for the accent.
export function TopBar({ title, source, stats, complexity, diffView, onSetDiffView, onRerun, rerunning }: TopBarProps) {
  return (
    <div className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-4">
      <span className="shrink-0 text-[14px] font-semibold text-[color:var(--text-strong)]">{title}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[color:var(--text-subtle)]">{source}</span>
      <span className="shrink-0 rounded-[5px] border border-[color:var(--border-default)] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[color:var(--text-muted)]">
        {stats.files} {stats.files === 1 ? 'file' : 'files'} · <span className="text-[color:var(--tone-good)]">+{stats.additions}</span>{' '}
        <span className="text-[color:var(--tone-error)]">−{stats.deletions}</span>
      </span>
      <span className="shrink-0 text-[11.5px] text-[color:var(--text-subtle)]">
        Complexity <span className="text-[color:var(--text-muted)]">{complexity}</span>
      </span>
      <SegmentedControl
        ariaLabel="Diff view"
        items={DIFF_VIEW_ITEMS}
        value={diffView}
        onChange={onSetDiffView}
        className="shrink-0"
      />
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
