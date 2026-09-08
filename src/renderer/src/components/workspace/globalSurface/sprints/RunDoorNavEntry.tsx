import React from 'react'

import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { isSprintRunWorkspace } from '../../../../utils/workspaceVisibility'
import { SprintEngineWorkspaceTypeIcon } from '../../../AppIcons'
import { StatusDot } from '../../../ui/StatusDot'
import { WorkflowsGlyph } from '../../surfaceGlyphs'
import { SidebarNavButton } from '../../SidebarNavButton'
import { sprintDoorAttention, type SprintDoorAttention } from './railState'
import { runsForDoor } from './runDoors'
import type { RunDoorDefinition } from './runDoorCopy'
import { useSprintRunIndex } from './useSprintRunIndex'

// The row a run door wears in the Extensions drawer (item 1763, two doors since
// item 2470), contributed by the `sprint-engine` module through the sidebar-nav
// contribution point.
//
// One component for both doors, for the same reason one surface serves both: the
// row is a label, a glyph, an aggregate dot and an open action, and only the
// first two differ. The dot reads the door's OWN runs — a workflow waiting on
// somebody must not light the Sprints row, or the operator opens a list the run
// is not in.
//
// The sidebar renders this only while the module is enabled, so it assumes it is
// live. It carries the run index's aggregate signal into the rail even while the
// surface is closed.
export function RunDoorNavEntry({
  door,
  collapsed,
}: SidebarNavEntryRenderProps & { door: RunDoorDefinition }) {
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  // One selected thing in the sidebar, and it is never nothing.
  //
  // The door is selected while its surface is open — that deselects the project
  // row, as any door does. Sprints is ALSO selected while the operator is inside
  // a run's agent terminals (item 1767): that workspace left the Projects list,
  // so no row can carry the selection, and an unselected sidebar would claim the
  // operator is nowhere. That fallback stays on Sprints alone, because a resident
  // workspace carries no run kind — reading one off disk to decide which of two
  // rows lights up would be a projection read per sidebar render.
  const active = useWorkspaceStore((s) => {
    if (s.activeGlobalSurface) return s.activeGlobalSurface === door.id
    if (door.id !== 'sprints') return false
    const activeWorkspace = s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)
    return Boolean(activeWorkspace && isSprintRunWorkspace(activeWorkspace))
  })
  const { runs } = useSprintRunIndex()
  const attention = sprintDoorAttention(runsForDoor(runs, door.id))
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<RunDoorRowIcon door={door} />}
      label={door.label}
      ariaLabel={door.label}
      tooltip={attention.waiting ? `${door.label} — waiting on you` : door.label}
      tooltipWhenExpanded
      active={active}
      indicator={runDoorNavIndicator(door, attention)}
      onClick={() => openGlobalSurface(door.id)}
    />
  )
}

// Sprints keeps the SprintEngine frond it has always worn; Workflows takes the
// fan-out mark the shell already knows it by, so the drawer row and the
// Extensions tile cannot show two different pictures of the same door.
function RunDoorRowIcon({ door }: { door: RunDoorDefinition }): JSX.Element {
  const className = 'icon-sm pointer-events-none shrink-0'
  if (door.id === 'workflows') return <WorkflowsGlyph className={className} />
  return <SprintEngineWorkspaceTypeIcon className={className} />
}

// Waiting-on-you outranks a live run: one is an ask, the other is informational.
// Same precedence the rail rows use, so the door and the rail never disagree.
function runDoorNavIndicator(
  door: RunDoorDefinition,
  attention: SprintDoorAttention,
): React.ReactNode {
  const noun = door.id === 'workflows' ? 'workflow' : 'sprint'
  if (attention.waiting) return <StatusDot tone="warn" label={`A ${noun} is waiting on you`} />
  if (attention.running) return <StatusDot tone="accent" pulse label={`A ${noun} is running`} />
  return null
}
