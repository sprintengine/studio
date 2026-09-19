import type { ReactNode } from 'react'

import type { AutomationsInstanceEntry, AutomationsProviders } from '../../../../../../shared/automations/contracts'
import type { BuiltinAutomation } from '../../../../../../shared/automations/builtin'
import { actionLabel } from '../../../panels/AutomationsPanel/automationsFormat'
import { AutomationTypeGlyph } from '../../../panels/AutomationsPanel/AutomationTypeGlyph'
import {
  SurfaceRail,
  type SurfaceRailFilter,
  type SurfaceRailGroup,
  type SurfaceRailRow,
  type SurfaceRailSearch,
} from '../surfaceSubstrate'
import { automationRailState } from './railState'
import { builtinRowId, builtinStateLine } from './builtinAutomations'

// The Automations surface rail (mockup §3; Extensions drawer ruling, 2026-09-05,
// frame 4). Every automation with a type glyph (what kind of thing it runs — an
// agent, a code review) and one plain-language state line ("Ran 2h ago
// · passed", "Running now", "Paused", "Last run failed"). "New automation" leads
// the rail, then the search + filter row (project / state). This is a navigation
// rail — selecting a row fills the canvas; the actions (run, edit, pause) live on
// the surface bar and canvas, not here.
//
// TWO groups, in this order: "Yours" — what the open projects actually run — then
// "Built in", the five automations that ship inside the app. Built in comes
// second because it is the shelf, not the inventory: what you have is the answer
// to "what runs here", and what ships is the answer to "what could". A built-in
// row's state line is its schedule in words, because it has no run state to
// report until a project takes a copy of it.
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20): the list
// semantics, ↑/↓ + j/k keyboard navigation, and row layout are the substrate's;
// this maps automation entries onto it and keeps the salience ordering upstream.
export function AutomationsRail({
  entries,
  builtins,
  addedBuiltinIds,
  selectedId,
  now,
  onSelect,
  onCreate,
  search,
  filter,
  emptyNotice,
  builtinNotice,
  providers,
}: {
  entries: AutomationsInstanceEntry[]
  /** The shipped five, as main reports them. Empty while the read is in flight or
   *  has failed — `builtinNotice` is what says which. */
  builtins: ReadonlyArray<BuiltinAutomation>
  /** Built-in ids the add target already holds, so a row says so rather than
   *  offering an add that would be a no-op. */
  addedBuiltinIds: ReadonlySet<string>
  selectedId: string | null
  now: number
  onSelect: (rowId: string) => void
  onCreate: (anchor: { x: number; y: number }) => void
  search: SurfaceRailSearch
  filter?: SurfaceRailFilter
  /** Why a narrowed rail is empty. Only the door sees the unfiltered set, so it
   *  decides; the substrate places it under the head at the row inset. */
  emptyNotice?: ReactNode
  /** Why the "Built in" group is not listing five rows — the read is in flight,
   *  or it failed. Never an empty group in silence: that reads as "this app
   *  ships none", which is a different and false statement. */
  builtinNotice?: ReactNode
  providers?: AutomationsProviders | null
}): JSX.Element {
  const yourRows: SurfaceRailRow[] = entries.map((entry) => {
    const rail = automationRailState(entry, now)
    const kind = entry.definition.action.kind
    const glyph = providers?.actions.find((action) => action.kind === kind)?.glyph
    return {
      id: entry.definition.id,
      title: entry.definition.name,
      stateLine: rail.text,
      icon: <AutomationTypeGlyph kind={kind} glyph={glyph} label={actionLabel(kind, providers)} />,
      tooltip: `${entry.definition.name} — ${actionLabel(kind, providers)} · ${rail.text}`,
    }
  })

  const builtinRows: SurfaceRailRow[] = builtins.map((entry) => {
    const schedule = builtinStateLine(entry)
    const added = addedBuiltinIds.has(entry.id)
    return {
      id: builtinRowId(entry.id),
      title: entry.name,
      // Added is the more consequential half of the line — it is the difference
      // between "this could run here" and "this does" — so it leads, and the
      // schedule follows it rather than being replaced by it.
      stateLine: added ? `Added · ${schedule}` : schedule,
      icon: <AutomationTypeGlyph kind={entry.action.kind} />,
      tooltip: `${entry.name} — ships with the app · ${schedule}`,
    }
  })

  // Declared as groups even when one is empty, so the rail's shape does not
  // change under a filter: the substrate withholds a heading over a lone group,
  // which is what a first-run window (no automations of its own) should read as —
  // one list of five, headed by nothing, not a "Built in" header hanging under an
  // empty "Yours".
  const groups: SurfaceRailGroup[] = [
    ...(yourRows.length > 0 ? [{ key: 'yours', label: 'Yours', rows: yourRows }] : []),
    ...(builtinRows.length > 0 ? [{ key: 'builtin', label: 'Built in', rows: builtinRows }] : []),
  ]
  const rows = [...yourRows, ...builtinRows]

  return (
    <SurfaceRail
      label="Automations"
      rows={rows}
      groups={groups}
      selectedId={selectedId}
      onSelect={onSelect}
      newAffordance={{ label: 'New automation', onActivate: onCreate }}
      search={search}
      filter={filter}
      emptyNotice={emptyNotice}
      afterRows={builtinNotice ? <BuiltinNotice>{builtinNotice}</BuiltinNotice> : undefined}
    />
  )
}

// The built-in group's degraded line, at the row inset inside the scrollport —
// where the five rows would have been, not floated to the bottom of the column.
function BuiltinNotice({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline gap-1.5 px-2 pb-1 pt-2">
        <span className="text-micro font-semibold text-[color:var(--text-subtle)]">Built in</span>
      </div>
      <p className="px-2 text-meta leading-4 text-[color:var(--text-muted)]">{children}</p>
    </div>
  )
}
