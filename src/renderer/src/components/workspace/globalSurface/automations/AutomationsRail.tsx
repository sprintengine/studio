import type { ReactNode } from 'react'

import type { AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
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

// The Automations surface rail (mockup §3): every automation in this Multicode
// with a type glyph (what kind of thing it runs — an agent, a sprint, a code
// review) and one plain-language state line ("Ran 2h ago · passed", "Running
// now", "Paused", "Last run failed"). "New automation" leads the rail, then the
// search + filter row (project / state). This is a navigation rail — selecting a
// row fills the canvas; the actions (run, edit, pause) live on the surface bar
// and canvas, not here.
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20): the list
// semantics, ↑/↓ + j/k keyboard navigation, and row layout are the substrate's;
// this maps automation entries onto it and keeps the salience ordering upstream.
export function AutomationsRail({
  entries, selectedId, now, onSelect, onCreate, search, filter, emptyNotice,
}: {
  entries: AutomationsInstanceEntry[]
  selectedId: string | null
  now: number
  onSelect: (automationId: string) => void
  onCreate: (anchor: { x: number; y: number }) => void
  search: SurfaceRailSearch
  filter?: SurfaceRailFilter
  /** Why a narrowed rail is empty. Only the door sees the unfiltered set, so it
   *  decides; the substrate places it under the head at the row inset. */
  emptyNotice?: ReactNode
}): JSX.Element {
  const rows: SurfaceRailRow[] = entries.map((entry) => {
    const rail = automationRailState(entry, now)
    const kind = entry.definition.action.kind
    return {
      id: entry.definition.id,
      title: entry.definition.name,
      stateLine: rail.text,
      icon: <AutomationTypeGlyph kind={kind} />,
      tooltip: `${entry.definition.name} — ${actionLabel(kind)} · ${rail.text}`,
    }
  })
  // ONE group: what this project actually runs. The starter-editor prototype
  // carried a second "Starters" group here from when this door was a discovery
  // alternative; discovery is ruled to the Extensions shelf (MC-2035), so that
  // group would only duplicate it and is deliberately absent — restoring it is a
  // decision, not a repair. Declaring the group (rather than passing a flat list)
  // is what names the list "Automations: In this project" for a screen reader;
  // the substrate withholds the visible heading over a lone group, because a
  // header spanning every row separates nothing.
  const groups: SurfaceRailGroup[] = [{ key: 'in-this-project', label: 'In this project', rows }]
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
    />
  )
}
