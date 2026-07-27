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
//
// Each row also owns the per-horizon actions (MC-1917): making a draft active,
// revealing its file, and deleting it. They live on the row rather than the
// surface bar because they act on THAT horizon, not on whichever one the canvas
// happens to be showing. The trigger is a sibling of the row button (one click
// target per row) and the same menu opens on right-click.

import { useState } from 'react'

import { ContextMenu, LifecycleGlyph, MenuItem } from '../../ui'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
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

/** Which per-row actions a horizon offers, and how to run them. Every handler is
 *  optional so a host that cannot perform an action simply does not offer it —
 *  a menu item is never shown as a control that does nothing. */
export type RoadmapRailActions = {
  onMakeActive?: (roadmapRef: string) => void
  onRevealFile?: (roadmapRef: string) => void
  onDelete?: (roadmapRef: string) => void
}

export function RoadmapRail({
  rows,
  selectedRef,
  search,
  onSelect,
  onSearch,
  onNewRoadmap,
  actions,
}: {
  rows: ReadonlyArray<RoadmapRailRow>
  selectedRef: string | null
  search: string
  onSelect: (roadmapRef: string) => void
  onSearch: (query: string) => void
  onNewRoadmap: () => void
  actions?: RoadmapRailActions
}): JSX.Element {
  // The open row menu: which horizon, and where it was opened from. One at a
  // time — opening another row's menu replaces it.
  const [menu, setMenu] = useState<{ roadmapRef: string; x: number; y: number } | null>(null)

  const query = search.trim().toLowerCase()
  const visible = query ? rows.filter((row) => row.title.toLowerCase().includes(query)) : rows
  const hasActions = Boolean(actions?.onMakeActive || actions?.onRevealFile || actions?.onDelete)

  const railRows: SurfaceRailRow[] = visible.map((row) => ({
    id: row.roadmapRef,
    title: row.title,
    stateLine: row.stateLine,
    icon: (
      <LifecycleGlyph
        state={row.active ? 'in_progress' : 'todo'}
        live={row.running}
        label={row.active ? 'Active horizon' : 'Draft horizon'}
        className="shrink-0"
      />
    ),
    ...(hasActions
      ? {
          onContextMenu: (position: { x: number; y: number }) =>
            setMenu({ roadmapRef: row.roadmapRef, ...position }),
          actions: (
            <button
              type="button"
              aria-label={`Actions for ${row.title}`}
              onClick={(event) => {
                // The row button is a sibling, not an ancestor, but the click
                // still bubbles to the list — stop it so opening the menu does
                // not also change the canvas selection.
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                setMenu({ roadmapRef: row.roadmapRef, x: rect.left, y: rect.bottom })
              }}
              className={`flex h-5 w-5 items-center justify-center rounded text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <circle cx="4" cy="8" r="1.2" fill="currentColor" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                <circle cx="12" cy="8" r="1.2" fill="currentColor" />
              </svg>
            </button>
          ),
        }
      : {}),
  }))

  const menuRow = menu ? rows.find((row) => row.roadmapRef === menu.roadmapRef) ?? null : null

  return (
    <div className="flex min-h-0 flex-col">
      <SurfaceRail
        label="Horizons"
        rows={railRows}
        selectedId={selectedRef}
        onSelect={onSelect}
        newAffordance={{ label: 'New horizon', onActivate: onNewRoadmap }}
        search={{
          value: search,
          onChange: onSearch,
          placeholder: 'Search horizons…',
          ariaLabel: 'Search horizons',
        }}
      />
      {visible.length === 0 && rows.length > 0 ? (
        <p className="px-2 pt-2 text-[11px] leading-4 text-[color:var(--text-muted)]">
          No horizons match.
        </p>
      ) : null}
      {menu && menuRow ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={`Actions for ${menuRow.title}`}
          onClose={() => setMenu(null)}
        >
          {/* Making a horizon active is only ever offered on a draft — the active
              one is already active, and a disabled lookalike says nothing. */}
          {actions?.onMakeActive && !menuRow.active ? (
            <MenuItem
              onClick={() => {
                setMenu(null)
                actions.onMakeActive?.(menuRow.roadmapRef)
              }}
            >
              Make active
            </MenuItem>
          ) : null}
          {actions?.onRevealFile ? (
            <MenuItem
              onClick={() => {
                setMenu(null)
                actions.onRevealFile?.(menuRow.roadmapRef)
              }}
            >
              Reveal file
            </MenuItem>
          ) : null}
          {actions?.onDelete ? (
            <MenuItem
              variant="danger"
              onClick={() => {
                setMenu(null)
                actions.onDelete?.(menuRow.roadmapRef)
              }}
            >
              Delete horizon…
            </MenuItem>
          ) : null}
        </ContextMenu>
      ) : null}
    </div>
  )
}
