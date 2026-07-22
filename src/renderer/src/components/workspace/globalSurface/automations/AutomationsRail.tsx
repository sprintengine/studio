import type { AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
import { SurfaceRail, type SurfaceRailRow } from '../surfaceSubstrate'
import { automationRailState } from './railState'

// The Automations surface rail (mockup §3): every automation in this Multicode
// with a status dot and one plain-language state line ("Ran 2h ago · passed",
// "Running now", "Paused", "Last run failed"), then "New automation" at the
// bottom. This is a navigation rail — selecting a row fills the canvas; the
// actions (run, edit, pause) live on the surface bar and canvas, not here.
//
// A thin adapter over the shared SurfaceRail (backlog 1731 / T20): the list
// semantics, ↑/↓ + j/k keyboard navigation, and row layout are the substrate's;
// this maps automation entries onto it and keeps the salience ordering upstream.
export function AutomationsRail({
  entries, selectedId, now, onSelect, onCreate,
}: {
  entries: AutomationsInstanceEntry[]
  selectedId: string | null
  now: number
  onSelect: (automationId: string) => void
  onCreate: (anchor: { x: number; y: number }) => void
}): JSX.Element {
  const rows: SurfaceRailRow[] = entries.map((entry) => {
    const rail = automationRailState(entry, now)
    return {
      id: entry.definition.id,
      title: entry.definition.name,
      stateLine: rail.text,
      tone: rail.tone,
      pulse: rail.running,
    }
  })
  return (
    <SurfaceRail
      label="Automations"
      rows={rows}
      selectedId={selectedId}
      onSelect={onSelect}
      newAffordance={{ label: 'New automation', onActivate: onCreate }}
    />
  )
}
