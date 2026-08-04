import type { FilterMenuGroup } from '../../../ui'
import { SurfaceRail, type SurfaceRailGroup, type SurfaceRailRow } from '../surfaceSubstrate'
import {
  buildDesignRailGroups,
  designRowStateLine,
  designRowTitle,
  DESIGN_RAIL_STATUS_ITEMS,
  type DesignRailEntry,
  type DesignRailStatusFilter,
} from './designRailState'

// The Design door's rail (item 2002, mockup backlog/mockups/2026-07-30-design-door-shell.html).
// A thin adapter over the shared SurfaceRail, exactly like Sprints and
// Automations: list semantics, ↑/↓ + j/k navigation, the house New affordance,
// and the search + filter head are all the substrate's. Nothing here invents a
// mechanism, and nothing here mounts a second rail — the door's ONE rail is
// this, handed to GlobalSurfaceShell's `rail` prop (MC-2014).

/**
 * The identity chip: a rounded square in the system's own accent.
 *
 * Deliberately NOT the 6px circle — that is the status idiom, and spending it on
 * identity would make "this system exists" look like "this system is healthy".
 * A bundle whose accent could not be resolved gets an outlined square rather
 * than a fabricated colour, so an unreadable token file is visible as absence.
 */
function DesignSystemChip({ accent }: { accent: string | null }): JSX.Element {
  return (
    <span
      // Decorative: the row's own tooltip already names the system, and a title
      // on an aria-hidden node is unreachable anyway.
      aria-hidden="true"
      className={`size-3 shrink-0 rounded-[3px] ${
        accent ? '' : 'border border-dashed border-[color:var(--border-default)]'
      }`}
      // The previewed system's own colour is CONTENT, not our accent budget, so
      // it arrives as a value rather than through a token. Validated as a colour
      // by resolveAccentColor before it reaches here — token documents are
      // third-party content and never flow into a style attribute unchecked.
      style={accent ? { background: accent } : undefined}
    />
  )
}

export function DesignRail({
  entries,
  selectedId,
  accentMode,
  search,
  onSearch,
  status,
  onStatus,
  onSelect,
  onCreate,
  newSelected,
}: {
  entries: readonly DesignRailEntry[]
  /** The selected row, or null when the New affordance holds the selection. */
  selectedId: string | null
  /** Which of the bundle's two declared modes its accent is read for. */
  accentMode: 'light' | 'dark'
  search: string
  onSearch: (next: string) => void
  status: DesignRailStatusFilter
  onStatus: (next: DesignRailStatusFilter) => void
  onSelect: (id: string) => void
  onCreate: () => void
  /** True when New is the one focused selection, so the rows show none. */
  newSelected: boolean
}): JSX.Element {
  const modelGroups = buildDesignRailGroups(entries, search, status)
  const toRow = (entry: DesignRailEntry): SurfaceRailRow => {
    const title = designRowTitle(entry)
    const stateLine = designRowStateLine(entry)
    return {
      id: entry.id,
      title,
      stateLine,
      // A truncated row is still readable on hover, and a broken row's tooltip
      // carries the full path the state line had to shorten.
      tooltip: `${title} — ${stateLine}`,
      icon: <DesignSystemChip accent={entry.identity?.accent[accentMode] ?? null} />,
    }
  }
  const groups: SurfaceRailGroup[] = modelGroups.map((group) => ({
    key: group.key,
    label: group.label,
    rows: group.entries.map(toRow),
  }))
  // The substrate walks `rows` for keyboard navigation, so it must be the
  // groups' rows flattened in render order.
  const rows = groups.flatMap((group) => group.rows)

  // One axis, behind the filter glyph — the shared door anatomy keeps lenses
  // there rather than as a standing Select above the rows. It is offered only
  // once something is actually broken: with every system readable, "Needs
  // attention" narrows to nothing and the glyph is a control that does nothing.
  const anyBroken = entries.some((entry) => entry.failure !== null)
  const filterGroups: FilterMenuGroup[] = [
    {
      label: 'Status',
      items: DESIGN_RAIL_STATUS_ITEMS.map((item) => ({ value: item.value, label: item.label })),
      value: status,
      defaultValue: 'all',
      onChange: (next: string) => onStatus(next as DesignRailStatusFilter),
    },
  ]

  return (
    <SurfaceRail
      label="Design systems"
      rows={rows}
      groups={groups}
      // Exactly one focused selection across rail and canvas: while New holds
      // it, no row is current.
      selectedId={newSelected ? null : selectedId}
      onSelect={onSelect}
      newAffordance={{
        label: 'New design system',
        onActivate: onCreate,
        selected: newSelected,
      }}
      search={{
        value: search,
        onChange: onSearch,
        placeholder: 'Search design systems…',
        ariaLabel: 'Search your design systems',
      }}
      filter={
        anyBroken || status !== 'all'
          ? { ariaLabel: 'Filter design systems', groups: filterGroups }
          : undefined
      }
      // The lens is narrower than the systems behind it. Say so, rather than
      // letting a filtered-empty rail read as "you have no design systems".
      emptyNotice={entries.length > 0 ? 'No design systems match.' : undefined}
    />
  )
}
