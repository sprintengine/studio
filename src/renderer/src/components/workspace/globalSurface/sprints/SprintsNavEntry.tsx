import React from 'react'

import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { SprintEngineWorkspaceTypeIcon } from '../../../AppIcons'
import { StatusDot } from '../../../ui/StatusDot'
import { SidebarNavButton } from '../../SidebarNavButton'
import { sprintDoorAttention, type SprintDoorAttention } from './railState'
import { useSprintRunIndex } from './useSprintRunIndex'

// The Sprints top-nav door (item 1763), contributed by the `sprint-engine` module
// through the sidebar-nav host contribution point at the order-20 slot the
// hardcoded sidebar row used to hold. That row toggled the Sprint Engines aside —
// a survey panel floating over whichever project happened to be open, listing
// only runs whose workspace was still around. This opens the instance-global
// Sprints surface instead: every run, every project, live and historical.
//
// The sidebar renders this only while the module is enabled, so it assumes it is
// live. It carries the run index's aggregate signal into the rail even while the
// surface is closed, the way the Roadmap door carries its orchestrator's.
export function SprintsNavEntry({ collapsed }: SidebarNavEntryRenderProps) {
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  // One selected thing in the sidebar: opening the door deselects the project row.
  const active = useWorkspaceStore((s) => s.activeGlobalSurface === 'sprints')
  const { runs } = useSprintRunIndex()
  const attention = sprintDoorAttention(runs)
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<SprintEngineWorkspaceTypeIcon className="icon-xs pointer-events-none shrink-0" />}
      label="Sprints"
      ariaLabel="Sprints"
      tooltip={attention.waiting ? 'Sprints — waiting on you' : 'Sprints'}
      tooltipWhenExpanded
      active={active}
      indicator={sprintsNavIndicator(attention)}
      onClick={() => openGlobalSurface('sprints')}
    />
  )
}

// Waiting-on-you outranks a live run: one is an ask, the other is informational.
// Same precedence the rail rows use, so the door and the rail never disagree.
function sprintsNavIndicator(attention: SprintDoorAttention): React.ReactNode {
  if (attention.waiting) return <StatusDot tone="warn" label="A sprint is waiting on you" />
  if (attention.running) return <StatusDot tone="accent" pulse label="A sprint is running" />
  return null
}
