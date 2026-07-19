import type { ReviewBriefRunPhase } from '../../../../../shared/electron-api'
import { GhostButton } from '../../ui/Buttons'
import { Spinner } from '../../ui/Spinner'
import type { FreshnessBannerModel } from './freshness'

const REFRESH_PHASE_LABEL: Record<ReviewBriefRunPhase, string> = {
  reading: 'Re-reading the change…',
  grouping: 'Refreshing the affected steps…',
  annotating: 'Checking the walkthrough…',
  writing: 'Saving the walkthrough…',
  done: 'Walkthrough ready',
  failed: 'The refresh could not finish',
}

interface FreshnessBannerProps {
  model: FreshnessBannerModel
  // When a refresh is live the banner keeps the old walkthrough visible and shows
  // progress in place — never a blank surface mid-run.
  refreshing: boolean
  refreshPhase: ReviewBriefRunPhase | null
  onRefresh: () => void
}

// The freshness banner in the walkthrough's reserved slot (mockup §4). Warn tone
// when the head moved with a "Refresh walkthrough" action; quiet tone once the
// walkthrough is current again. While a refresh runs it shows the phase inline so
// the old walkthrough stays readable underneath.
export function FreshnessBanner({ model, refreshing, refreshPhase, onRefresh }: FreshnessBannerProps) {
  const quiet = model.tone === 'current'
  return (
    <div
      className={`flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] px-4 py-2 ${
        quiet ? 'bg-[color:var(--bg-hover)]' : 'bg-[color:var(--tone-warn-soft)]'
      }`}
      role="status"
    >
      <span className={`min-w-0 flex-1 text-[12px] leading-5 ${quiet ? 'text-[color:var(--text-subtle)]' : 'text-[color:var(--text-strong)]'}`}>
        {model.lead ? <span className="font-semibold">{model.lead} </span> : null}
        {model.detail}
      </span>
      {refreshing ? (
        <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-[color:var(--text-muted)]">
          <Spinner />
          {REFRESH_PHASE_LABEL[refreshPhase ?? 'grouping']}
        </span>
      ) : model.refreshable ? (
        <GhostButton onClick={onRefresh} className="shrink-0">
          <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
            <path
              d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Refresh walkthrough
        </GhostButton>
      ) : null}
    </div>
  )
}

export default FreshnessBanner
