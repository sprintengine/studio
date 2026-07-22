// The roadmaps rail: the list panel inside the Roadmap surface (global-surfaces
// epic 1704, mockup §2). It lists every roadmap file in this Multicode with its
// state line, gives the one-active-roadmap rule (epic 1687 D1) a visible home —
// exactly one row reads "Active", the rest read "Draft" — and carries the "New
// roadmap" affordance. Selecting a row shows that roadmap on the canvas; it never
// silently activates a draft (that is an explicit action on the surface bar).
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20): the list
// semantics, ↑/↓ + j/k keyboard navigation, and row layout live once in the
// substrate; this maps roadmap rows onto it.

import { SurfaceRail, type SurfaceRailRow } from '../../workspace/globalSurface/surfaceSubstrate'

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
  const railRows: SurfaceRailRow[] = rows.map((row) => ({
    id: row.roadmapRef,
    title: row.title,
    stateLine: row.stateLine,
    tone: row.active ? 'accent' : 'neutral',
    pulse: row.running,
    dotLabel: row.active ? 'Active roadmap' : 'Draft roadmap',
  }))
  return (
    <SurfaceRail
      label="Roadmaps"
      rows={railRows}
      selectedId={selectedRef}
      onSelect={onSelect}
      newAffordance={{ label: 'New roadmap', onActivate: onNewRoadmap }}
    />
  )
}
