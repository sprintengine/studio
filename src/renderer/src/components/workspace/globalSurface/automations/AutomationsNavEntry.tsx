import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { AutomationsWorkspaceTypeIcon } from '../../../AppIcons'
import { SidebarNavButton } from '../../SidebarNavButton'

// The Automations top-nav door, contributed by the `automations` capability
// module through the sidebar-nav host contribution point (global-surfaces epic
// 1704 / item 1707). It replaces the old hardcoded sidebar button + host
// project-picker menu: automations are no longer workspaces in the Projects
// list, so the door opens the instance-wide full-page surface (mounted by
// WorkspaceManager over the card region, like Roadmap) against THIS window's
// store. Shown whenever the automations module is enabled — no longer gated on a
// host existing, since a first-class surface carries its own "New automation".
export function AutomationsNavEntry({ collapsed }: SidebarNavEntryRenderProps) {
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const active = useWorkspaceStore((s) => s.activeGlobalSurface === 'automations')
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<AutomationsWorkspaceTypeIcon className="icon-xs pointer-events-none shrink-0" />}
      label="Automations"
      ariaLabel="Automations"
      tooltip="Automations"
      tooltipWhenExpanded
      active={active}
      onClick={() => openGlobalSurface('automations')}
    />
  )
}
