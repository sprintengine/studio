import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import { SurfaceRail } from '../surfaceSubstrate'
import { buildSprintRailRows, deriveSprintProjectChips } from './railState'

// The Sprints surface rail (mockup §2): the project filter chips, then every run
// in this Multicode as one dot + name + plain state line, then "New sprint".
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20) — list
// semantics, ↑/↓ + j/k navigation, and row layout are the substrate's. Row
// building, ordering, and filtering are `railState`'s. What is left here is the
// chip strip, which is this door's own affordance.
export function SprintsRail({
  runs,
  selectedStatePath,
  projectFilter,
  onSelect,
  onFilter,
  onCreate,
}: {
  runs: ReadonlyArray<SprintRunSummary>
  selectedStatePath: string | null
  /** Project root the rail is narrowed to, or null for every project. */
  projectFilter: string | null
  onSelect: (statePath: string) => void
  onFilter: (projectRoot: string | null) => void
  onCreate: () => void
}): JSX.Element {
  const chips = deriveSprintProjectChips(runs)
  const rows = buildSprintRailRows(runs, projectFilter)
  return (
    <div className="flex min-h-0 flex-col">
      {/* One chip per project holding a run, plus "All projects". Offered only
          when there is a second project to choose between — a lone chip beside
          "All projects" filters nothing. */}
      {chips.length > 1 ? (
        <div role="group" aria-label="Filter sprints by project" className="flex flex-wrap gap-1 px-1 pb-2.5">
          <ProjectChip label="All projects" selected={projectFilter === null} onSelect={() => onFilter(null)} />
          {chips.map((chip) => (
            <ProjectChip
              key={chip.projectRoot}
              label={chip.label}
              selected={projectFilter === chip.projectRoot}
              onSelect={() => onFilter(chip.projectRoot)}
            />
          ))}
        </div>
      ) : null}
      <SurfaceRail
        label="Sprints"
        rows={rows}
        selectedId={selectedStatePath}
        onSelect={onSelect}
        newAffordance={{ label: 'New sprint', onActivate: onCreate }}
      />
      {/* The filter is narrower than the runs behind it. Say so, rather than
          letting an empty rail read as "you have no sprints". */}
      {rows.length === 0 && runs.length > 0 ? (
        <p className="px-2 pt-2 text-[11px] leading-4 text-[color:var(--text-muted)]">
          No sprints in this project.
        </p>
      ) : null}
    </div>
  )
}

// A filter chip. Pressed state carries the selection for screen readers, so the
// accent fill is not the only signal.
function ProjectChip({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`h-[20px] max-w-full truncate rounded-full px-2.5 text-[10.5px] transition-colors ${FOCUS_RING_CLASS} ${
        selected
          ? 'bg-[color:var(--accent-primary-soft)] font-medium text-[color:var(--accent-primary)]'
          : 'border border-[color:var(--border-default)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      {label}
    </button>
  )
}
