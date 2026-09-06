import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { LifecycleGlyph } from '../../../ui'
import { basename } from '../../../../utils/paths'
import { SurfaceRail, type SurfaceRailRow, type SurfaceRailScope } from '../surfaceSubstrate'
import {
  buildSprintRailGroups,
  deriveSprintProjectChips,
  sprintRunMatchesSearch,
  SPRINT_SORT_ITEMS,
  type SprintRailRow,
  type SprintSort,
} from './railState'
import { RunDoorNewRow } from './RunDoorNewRow'
import { SPRINTS_DOOR, type RunDoorDefinition } from './runDoorCopy'

// Both run doors' rail (MC-1838, two doors since item 2470): the list IS the
// inbox. Runs group under "Needs you" (waiting on a person, honest since-dates),
// "Active" (genuinely live), and "Recent" (everything else) — there is no
// separate waiting strip pinned above the canvas. New leads the rail, then the project lens,
// then the search field with the sort axis behind the filter glyph — the
// Backlog door's toolbar order (MC-1816), so the project filter sits in the
// same place on both doors instead of leading the toolbar there and hiding
// behind a glyph here.
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20) — list
// semantics, ↑/↓ + j/k navigation, and row layout are the substrate's. Row
// building, grouping, filtering, and search matching are `railState`'s.
//
// One rail for both doors, parameterised by the door definition: every word that
// differs between Workflows and Sprints comes from `runDoorCopy`, and the runs
// have already been partitioned by the surface before they reach here. The
// door's one sentence sits at the top, under its name, and the `+` sits at the
// END of the list where the mockup puts it — the rail's New-at-top affordance
// stays where it has always been, so the Sprints door keeps everything it had.

const ALL_PROJECTS = ' all'

/**
 * The whole-row tooltip: the run, the lifecycle word its glyph draws, and the
 * state line — so Merged / Ready for review is readable on hover and focus even
 * where the glyph alone carries it. It rides the substrate's product `Tooltip`
 * on the row button (never a native `title`), which is why it is a pure
 * function the rail test can assert on rather than markup it can grep for.
 */
export function sprintRowTooltip(row: SprintRailRow): string {
  return `${row.title} — ${row.glyph.label} · ${row.stateLine}`
}

export function SprintsRail({
  door = SPRINTS_DOOR,
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
  /** Which door this rail is. Defaults to Sprints, the door that predates the
   *  split — so a caller that never heard of the other one still gets its copy. */
  door?: RunDoorDefinition
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
      tooltip: sprintRowTooltip(row),
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
  // A lens narrowed to a project whose last run has since been deleted: the
  // chips are derived from the runs, so that project is no longer among them.
  // Keep its option — the trigger must name the lens that is actually applied
  // (never the Select's placeholder), and it is the only way back to All
  // projects (the Backlog door's rule for a project it can no longer count).
  const strandedFilter =
    projectFilter && !chips.some((chip) => chip.projectRoot === projectFilter) ? projectFilter : null
  // The project lens, leading the rail exactly as it leads the Backlog toolbar.
  // Offered only when there is a second project to choose between — a lone
  // option beside "All projects" narrows nothing. Options carry their run count,
  // and `deriveSprintProjectChips` derives them from the runs themselves, so a
  // project with no run is never listed.
  const projectScope: SurfaceRailScope | undefined =
    chips.length > 1 || strandedFilter
      ? {
          ariaLabel: door.scopeAriaLabel,
          items: [
            { value: ALL_PROJECTS, label: `All projects · ${runs.length}` },
            ...chips.map((chip) => ({
              value: chip.projectRoot,
              label: `${chip.label} · ${chip.runCount}`,
            })),
            ...(strandedFilter
              ? [{ value: strandedFilter, label: `${basename(strandedFilter)} · no ${door.nounPlural}` }]
              : []),
          ],
          value: projectFilter ?? ALL_PROJECTS,
          onChange: (next: string) => onFilter(next === ALL_PROJECTS ? null : next),
        }
      : undefined
  // Sort is always offered (the Backlog idiom), and it is the only axis behind
  // the glyph now that the project lens leads the rail.
  const filterGroups = [
    {
      label: 'Sort',
      items: SPRINT_SORT_ITEMS.map((item) => ({ value: item.value as string, label: item.label })),
      value: sort as string,
      defaultValue: 'recent',
      onChange: (next: string) => onSort(next as SprintSort),
    },
  ]
  return (
    <SurfaceRail
      label={door.label}
      // The difference between the two doors, stated once, under the door's
      // name — and never again anywhere on the surface (item 2470).
      intro={door.tagline}
      rows={rows}
      groups={groups}
      selectedId={selectedStatePath}
      onSelect={onSelect}
      newAffordance={{ label: door.newLabel, onActivate: onCreate }}
      scope={projectScope}
      search={{
        value: search,
        onChange: onSearch,
        placeholder: door.search.placeholder,
        ariaLabel: door.search.ariaLabel,
      }}
      filter={{ ariaLabel: door.filterAriaLabel, groups: filterGroups }}
      // The lens is narrower than the runs behind it. Say so, rather than
      // letting an empty rail read as "you have none". The substrate
      // renders it under the head at the row inset; it used to be a sibling of
      // the rail, which put it at the bottom of the column (MC-2101).
      emptyNotice={
        runs.length > 0
          ? (search.trim() ? door.emptyRail.searched : door.emptyRail.scoped)
          : undefined
      }
      // The `+` at the end of the list, opening inline on the row where it was
      // (owner ruling R7). It rides `afterRows` because that is the slot INSIDE
      // the rail's one scrollport — a form beside the list would scroll
      // separately from the list it belongs to.
      afterRows={<RunDoorNewRow door={door} projectFilter={projectFilter} />}
    />
  )
}
