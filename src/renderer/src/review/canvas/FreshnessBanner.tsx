import type { ReviewBriefRunPhase } from '../../../../shared/electron-api'
import { Banner } from '../../components/ui/Banner'
import { GhostButton } from '../../components/ui/Buttons'
import { Spinner } from '../../components/ui/Spinner'
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

// The freshness banner in the walkthrough's reserved slot (mockup §4).
//
// This used to be `ui/Banner` rebuilt by hand — different padding, a
// `--border-subtle` bottom rule instead of the primitive's, and no status dot
// at all (MC-2115). It is the kit's Banner now, and the two states it carries
// split along the tone vocabulary rather than along a private "quiet" tone the
// system does not have:
//
//   head moved  a WARN banner — the walkthrough still reads, but it is behind
//               the change — with "Refresh walkthrough" as its recovery.
//   current     not a notice at all. A resolved condition unmounts its banner
//               (no success residue), so what is left is the quiet provenance
//               line saying when the walkthrough was built.
//
// While a refresh runs the recovery slot carries the phase instead of the
// button, so the old walkthrough stays readable underneath.
export function FreshnessBanner({ model, refreshing, refreshPhase, onRefresh }: FreshnessBannerProps) {
  const message = model.lead ? `${model.lead} ${model.detail}` : model.detail

  if (model.tone === 'current') {
    return (
      <div
        className="flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-hover)] px-4 py-2"
        role="status"
      >
        <span className="min-w-0 flex-1 text-meta leading-5 text-[color:var(--text-subtle)]">{message}</span>
        {refreshing ? <RefreshProgress phase={refreshPhase} /> : null}
      </div>
    )
  }

  return (
    <Banner
      tone="warn"
      message={message}
      action={
        refreshing ? (
          <RefreshProgress phase={refreshPhase} />
        ) : model.refreshable ? (
          <GhostButton onClick={onRefresh}>
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
        ) : null
      }
    />
  )
}

function RefreshProgress({ phase }: { phase: ReviewBriefRunPhase | null }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-meta text-[color:var(--text-muted)]">
      <Spinner />
      {REFRESH_PHASE_LABEL[phase ?? 'grouping']}
    </span>
  )
}

export default FreshnessBanner
