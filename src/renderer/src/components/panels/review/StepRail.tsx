import type { RailModel, StepView } from './reviewSelectors'
import { OVERVIEW_PANE_ID } from './reviewSelectors'
import { PrimaryButton } from '../../ui/Buttons'

interface StepRailProps {
  rail: RailModel
  activePaneId: string
  onSelectPane: (id: string) => void
}

function StepRing({ view }: { view: StepView }) {
  if (view.read) {
    return (
      <span className="relative z-[1] mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]">
        <svg viewBox="0 0 16 16" className="icon-xs" fill="none" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  return (
    <span className="relative z-[1] mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] text-[10.5px] font-semibold tabular-nums text-[color:var(--text-muted)]">
      {view.index}
    </span>
  )
}

// The left rail: a progress meter, the Overview entry, the ordered steps joined
// by a connector line (each with a read/active ring), and a footer that reports
// files read and offers the next unread step.
export function StepRail({ rail, activePaneId, onSelectPane }: StepRailProps) {
  return (
    <div className="flex h-full flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] py-4">
      <div className="px-4 pb-2.5">
        <span className="text-[11px] font-medium text-[color:var(--text-subtle)]">Walkthrough</span>
        <div
          className="mt-2 h-[3px] overflow-hidden rounded-full bg-[color:var(--bg-active)]"
          role="progressbar"
          aria-label="Reading progress"
          aria-valuenow={Math.round(rail.meterFraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-[color:var(--accent-primary)] transition-[width] duration-[var(--motion-deliberate)] ease-[var(--motion-ease)] motion-reduce:transition-none"
            style={{ width: `${Math.round(rail.meterFraction * 100)}%` }}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => onSelectPane(OVERVIEW_PANE_ID)}
        aria-current={activePaneId === OVERVIEW_PANE_ID ? 'true' : undefined}
        className={`relative mb-0.5 flex w-full items-start gap-2.5 px-4 py-2.5 text-left ${
          activePaneId === OVERVIEW_PANE_ID
            ? 'bg-[color:var(--accent-primary-soft)] before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-[color:var(--accent-primary)] before:content-[""]'
            : 'hover:bg-[color:var(--bg-hover)]'
        }`}
      >
        <span
          className={`relative z-[1] mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border bg-[color:var(--bg-surface)] text-[11px] ${
            activePaneId === OVERVIEW_PANE_ID
              ? 'border-[color:var(--accent-primary)] text-[color:var(--accent-primary)]'
              : 'border-[color:var(--border-strong)] text-[color:var(--text-muted)]'
          }`}
          aria-hidden="true"
        >
          ◈
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium leading-tight text-[color:var(--text-strong)]">Overview</span>
          <span className="mt-0.5 block text-[11px] text-[color:var(--text-subtle)]">What this change is · blast radius</span>
        </span>
      </button>

      <div className="relative before:absolute before:bottom-3.5 before:left-[26px] before:top-3.5 before:w-px before:bg-[color:var(--border-subtle)] before:content-['']">
        {rail.steps.map((view) => {
          const active = activePaneId === view.step.id
          return (
            <button
              key={view.step.id}
              type="button"
              onClick={() => onSelectPane(view.step.id)}
              aria-current={active ? 'true' : undefined}
              className={`relative flex w-full items-start gap-2.5 px-4 py-2.5 text-left ${
                active
                  ? 'bg-[color:var(--accent-primary-soft)] before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-[color:var(--accent-primary)] before:content-[""]'
                  : 'hover:bg-[color:var(--bg-hover)]'
              }`}
            >
              <StepRing view={view} />
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-[13px] font-medium leading-tight ${active ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-strong)]'}`}
                >
                  {view.step.title}
                </span>
                <span className="mt-0.5 block text-[11px] tabular-nums text-[color:var(--text-subtle)]">{view.metaLabel}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-auto border-t border-[color:var(--border-subtle)] px-4 pt-3.5">
        <div className="mb-2.5 text-[11px] tabular-nums text-[color:var(--text-subtle)]">{rail.progressLabel}</div>
        {rail.continueStepId && rail.continueLabel ? (
          <PrimaryButton className="w-full justify-center" onClick={() => onSelectPane(rail.continueStepId as string)}>
            {rail.continueLabel}
          </PrimaryButton>
        ) : (
          <div className="text-[11px] text-[color:var(--text-muted)]">All files read.</div>
        )}
      </div>
    </div>
  )
}

export default StepRail
