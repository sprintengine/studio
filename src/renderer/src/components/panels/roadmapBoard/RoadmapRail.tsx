// The roadmaps rail: the list panel inside the Roadmap surface (global-surfaces
// epic 1704, mockup §2). It lists every roadmap file in this Multicode with its
// state line, gives the one-active-roadmap rule (epic 1687 D1) a visible home —
// exactly one row reads "Active", the rest read "Draft" — and leads with the
// "New roadmap" affordance over a search field. Selecting a row shows that
// roadmap on the canvas; it never silently activates a draft (that is an
// explicit action on the surface bar).
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20): the list
// semantics, ↑/↓ + j/k keyboard navigation, and row layout live once in the
// substrate; this maps roadmap rows onto it. Rows carry the app's lifecycle
// glyphs (the active roadmap is in-progress work, a draft an empty ring) —
// never a bare tone dot.

import { LifecycleGlyph } from '../../ui'
import { SurfaceRail, type SurfaceRailRow } from '../../workspace/globalSurface/surfaceSubstrate'

export type RoadmapRailRow = {
  roadmapRef: string
  title: string
  // The single orchestrated roadmap; every other row is a draft.
  active: boolean
  // "Active · step 3 of 7" or "Draft" — the row's at-a-glance state.
  stateLine: string
  // The active roadmap has a sprint running right now (drives the live spinner).
  running: boolean
}

export function RoadmapRail({
  rows,
  selectedRef,
  search,
  onSelect,
  onSearch,
  onNewRoadmap,
}: {
  rows: ReadonlyArray<RoadmapRailRow>
  selectedRef: string | null
  search: string
  onSelect: (roadmapRef: string) => void
  onSearch: (query: string) => void
  onNewRoadmap: () => void
}): JSX.Element {
  const query = search.trim().toLowerCase()
  const visible = query ? rows.filter((row) => row.title.toLowerCase().includes(query)) : rows
  const railRows: SurfaceRailRow[] = visible.map((row) => ({
    id: row.roadmapRef,
    title: row.title,
    stateLine: row.stateLine,
    icon: (
      <LifecycleGlyph
        state={row.active ? 'in_progress' : 'todo'}
        live={row.running}
        label={row.active ? 'Active roadmap' : 'Draft roadmap'}
        className="shrink-0"
      />
    ),
  }))
  return (
    <div className="flex min-h-0 flex-col">
      <SurfaceRail
        label="Roadmaps"
        rows={railRows}
        selectedId={selectedRef}
        onSelect={onSelect}
        newAffordance={{ label: 'New roadmap', onActivate: onNewRoadmap }}
        search={{
          value: search,
          onChange: onSearch,
          placeholder: 'Search roadmaps…',
          ariaLabel: 'Search roadmaps',
        }}
      />
      {visible.length === 0 && rows.length > 0 ? (
        <p className="px-2 pt-2 text-[11px] leading-4 text-[color:var(--text-muted)]">
          No roadmaps match.
        </p>
      ) : null}
    </div>
  )
}
