import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { LifecycleGlyph } from '../../../ui'
import { SurfaceRail, type SurfaceRailRow } from '../surfaceSubstrate'
import {
  buildSprintRailGroups,
  deriveSprintProjectChips,
  sprintRunMatchesSearch,
  SPRINT_SORT_ITEMS,
  type SprintRailRow,
  type SprintSort,
} from './railState'

// The Sprints surface rail (MC-1838): the list IS the inbox. Runs group under
// "Needs you" (waiting on a person, honest since-dates), "Active" (genuinely
// live), and "Recent" (everything else) — there is no separate waiting strip
// pinned above the canvas. "New sprint" leads the rail, then the search field
// with the project filter behind the filter glyph (the Backlog toolbar idiom).
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20) — list
// semantics, ↑/↓ + j/k navigation, and row layout are the substrate's. Row
// building, grouping, filtering, and search matching are `railState`'s.

const ALL_PROJECTS = ' all'

export function SprintsRail({
  runs,
  selectedStatePath,
  projectFilter,
  search,
  sort,
  onSelect,
  onFilter,
  onSearch,
  onSort,
  onCreate,
}: {
  runs: ReadonlyArray<SprintRunSummary>
  selectedStatePath: string | null
  /** Project root the rail is narrowed to, or null for every project. */
  projectFilter: string | null
  /** Search query over team/project names; empty for no narrowing. */
  search: string
  /** Row order within the groups — recency by default (the Backlog idiom). */
  sort: SprintSort
  onSelect: (statePath: string) => void
  onFilter: (projectRoot: string | null) => void
  onSearch: (query: string) => void
  onSort: (sort: SprintSort) => void
  onCreate: () => void
}): JSX.Element {
  const chips = deriveSprintProjectChips(runs)
  // Rows carry the app's lifecycle iconography — the SAME marks the Backlog
  // rows use (Merged purple branch, Ready for review, Complete disc, Needs
  // input, running spinner) — never a bare tone dot. The tooltip names the
  // glyph's state, so Merged/Ready-for-review is readable on hover too.
  const withGlyphIcons = (rows: readonly SprintRailRow[]): SurfaceRailRow[] =>
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      stateLine: row.stateLine,
      tooltip: `${row.title} — ${row.glyph.label} · ${row.stateLine}`,
      icon: (
        <LifecycleGlyph
          state={row.glyph.state}
          live={row.glyph.live}
          label={row.glyph.label}
          className="shrink-0"
        />
      ),
    }))
  const searched = runs.filter((summary) => sprintRunMatchesSearch(summary, search))
  const rawGroups = buildSprintRailGroups(searched, projectFilter, sort)
  const groups = rawGroups.map((group) => ({ ...group, rows: withGlyphIcons(group.rows) }))
  const rows = groups.flatMap((group) => group.rows)
  // Sort is always offered (the Backlog idiom); the project lens only when there
  // is a second project to choose between — a lone option beside "All projects"
  // filters nothing.
  const filterGroups = [
    ...(chips.length > 1
      ? [
          {
            label: 'Project',
            items: [
              { value: ALL_PROJECTS, label: `All projects · ${runs.length}` },
              ...chips.map((chip) => ({
                value: chip.projectRoot,
                label: `${chip.label} · ${chip.runCount}`,
              })),
            ],
            value: projectFilter ?? ALL_PROJECTS,
            defaultValue: ALL_PROJECTS,
            onChange: (next: string) => onFilter(next === ALL_PROJECTS ? null : next),
          },
        ]
      : []),
    {
      label: 'Sort',
      items: SPRINT_SORT_ITEMS.map((item) => ({ value: item.value as string, label: item.label })),
      value: sort as string,
      defaultValue: 'recent',
      onChange: (next: string) => onSort(next as SprintSort),
    },
  ]
  return (
    <div className="flex min-h-0 flex-col">
      <SurfaceRail
        label="Sprints"
        rows={rows}
        groups={groups}
        selectedId={selectedStatePath}
        onSelect={onSelect}
        newAffordance={{ label: 'New sprint', onActivate: onCreate }}
        search={{
          value: search,
          onChange: onSearch,
          placeholder: 'Search sprints…',
          ariaLabel: 'Search sprints across every project',
        }}
        filter={{ ariaLabel: 'Filter and sort sprints', groups: filterGroups }}
      />
      {/* The lens is narrower than the runs behind it. Say so, rather than
          letting an empty rail read as "you have no sprints". */}
      {rows.length === 0 && runs.length > 0 ? (
        <p className="px-2 pt-2 text-[11px] leading-4 text-[color:var(--text-muted)]">
          {search.trim() ? 'No sprints match.' : 'No sprints in this project.'}
        </p>
      ) : null}
    </div>
  )
}
