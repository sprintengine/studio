// The roadmaps rail: the list panel inside the Roadmap surface (global-surfaces
// epic 1704, mockup §2). It lists every roadmap file in this Multicode with its
// state line, gives the one-active-roadmap rule (epic 1687 D1) a visible home —
// exactly one row reads "Active", the rest read "Draft" — and carries the "New
// roadmap" affordance. Selecting a row shows that roadmap on the canvas; it never
// silently activates a draft (that is an explicit action on the surface bar).

import React from 'react'

import { StatusDot } from '../../ui/StatusDot'
import { FOCUS_RING_CLASS } from '../../ui/tokens'

export type RoadmapRailRow = {
  roadmapRef: string
  title: string
  // The single orchestrated roadmap; every other row is a draft.
  active: boolean
  // "Active · step 3 of 7" or "Draft" — the row's at-a-glance state.
  stateLine: string
  // The active roadmap has a sprint running right now (drives the pulse dot).
  running: boolean
}

export function RoadmapRail({
  rows,
  selectedRef,
  onSelect,
  onNewRoadmap,
}: {
  rows: ReadonlyArray<RoadmapRailRow>
  selectedRef: string | null
  onSelect: (roadmapRef: string) => void
  onNewRoadmap: () => void
}): JSX.Element {
  return (
    <>
      <div className="px-2 pb-1.5 pt-0.5 text-[11px] font-semibold text-[color:var(--text-subtle)]">Roadmaps</div>
      {rows.map((row) => {
        const selected = row.roadmapRef === selectedRef
        return (
          <button
            key={row.roadmapRef}
            type="button"
            onClick={() => onSelect(row.roadmapRef)}
            aria-current={selected ? 'true' : undefined}
            className={`interactive flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
              selected
                ? 'bg-[color:var(--bg-selected)]'
                : 'hover:bg-[color:var(--bg-hover)]'
            }`}
          >
            <StatusDot
              tone={row.active ? 'accent' : 'neutral'}
              pulse={row.running}
              size={7}
              label={row.active ? 'Active roadmap' : 'Draft roadmap'}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className="truncate text-[12px] font-medium text-[color:var(--text-strong)]"
                title={row.title}
              >
                {row.title}
              </span>
              <span className="truncate text-[10.5px] text-[color:var(--text-subtle)]">{row.stateLine}</span>
            </span>
          </button>
        )
      })}
      <button
        type="button"
        onClick={onNewRoadmap}
        className={`interactive mt-1.5 flex w-full items-center gap-2 rounded-md border border-dashed border-[color:var(--border-default)] px-2 py-1.5 text-[12px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        New roadmap
      </button>
    </>
  )
}
