import type { RailModel, StepView } from './reviewSelectors'
import { OVERVIEW_PANE_ID } from './reviewSelectors'
import { OutlineButton } from '../../components/ui/Buttons'
import { RowButton } from '../../components/ui/RowButton'

interface StepRailProps {
  rail: RailModel
  activePaneId: string
  onSelectPane: (id: string) => void
}

function StepRing({ view }: { view: StepView }) {
  if (view.read) {
    return (
      <span className="relative mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]">
        <svg viewBox="0 0 16 16" className="icon-xs" fill="none" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  return (
    <span className="relative mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] text-micro font-semibold tabular-nums text-[color:var(--text-muted)]">
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
        {/* `ui/Section`'s heading treatment rather than the component: a
            progress meter sits under this label inside the rail's own head,
            which `Section` cannot host. Same size and ink as every other
            section heading on the canvas. */}
        <h3 className="text-meta font-semibold text-[color:var(--text-strong)]">Walkthrough</h3>
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

      {/* `bleed`: a full-bleed rail row — no radius, and the inset ring an
          edge-to-edge row needs. Selection is the kit's neutral canon. */}
      <RowButton
        density="bleed"
        selected={activePaneId === OVERVIEW_PANE_ID}
        onClick={() => onSelectPane(OVERVIEW_PANE_ID)}
        className="relative mb-0.5"
      >
        {/* Selection is neutral: the row's `bg-selected` fill and the ink lift
            carry "active", never an accent ring — the accent here marks read
            progress (StepRing) and nothing else. The mark is an svg, not a
            text character. */}
        <span
          className={`relative mt-px inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] ${
            activePaneId === OVERVIEW_PANE_ID ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'
          }`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" className="icon-xs" fill="none" aria-hidden="true">
            <path d="M8 2.5l5.5 5.5L8 13.5 2.5 8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M8 5.5L10.5 8 8 10.5 5.5 8z" fill="currentColor" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium leading-tight text-[color:var(--text-strong)]">Overview</span>
          <span className="mt-0.5 block text-micro text-[color:var(--text-subtle)]">What this change is · blast radius</span>
        </span>
      </RowButton>

      {/* The connector line is this element's ::before, so the step rings mask
          it by tree order alone — they are siblings on the same layer, not a
          raise above it, and take no z-index. */}
      {/* design-tokens-allow: alignment — the connector line's end insets centre it on the 19px step rings at the first and last row, and its left inset is the kit row's own 8px plus half a ring; geometry, not rhythm */}
      <div className="relative before:absolute before:bottom-3.5 before:left-[18px] before:top-3.5 before:w-px before:bg-[color:var(--border-subtle)] before:content-['']">
        {rail.steps.map((view) => {
          const active = activePaneId === view.step.id
          return (
            <RowButton
              key={view.step.id}
              density="bleed"
              selected={active}
              onClick={() => onSelectPane(view.step.id)}
              className="relative"
            >
              <StepRing view={view} />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium leading-tight text-[color:var(--text-strong)]">
                  {view.step.title}
                </span>
                <span className="mt-0.5 block text-micro tabular-nums text-[color:var(--text-subtle)]">{view.metaLabel}</span>
              </span>
            </RowButton>
          )
        })}
      </div>

      <div className="mt-auto border-t border-[color:var(--border-subtle)] px-4 pt-3">
        <div className="mb-2.5 text-micro tabular-nums text-[color:var(--text-subtle)]">{rail.progressLabel}</div>
        {/* Outline, not primary: the door bar's "Post review" is the view's one
            solid accent (ruling 9), and this rail sits under it. */}
        {rail.continueStepId && rail.continueLabel ? (
          <OutlineButton className="w-full justify-center" onClick={() => onSelectPane(rail.continueStepId as string)}>
            {rail.continueLabel}
          </OutlineButton>
        ) : (
          <div className="text-micro text-[color:var(--text-muted)]">All files read.</div>
        )}
      </div>
    </div>
  )
}

export default StepRail
