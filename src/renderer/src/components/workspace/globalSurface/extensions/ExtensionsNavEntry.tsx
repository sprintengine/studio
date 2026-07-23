import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { SidebarNavButton } from '../../SidebarNavButton'
import { consumePendingExtensionsSurfaceTarget } from './extensionsSurfaceTarget'

// The Extensions top-nav door (MC-1847 B1), contributed by the always-on
// agent-runtime core through the sidebar-nav host contribution point. It
// replaces the hardcoded Connectors sidebar button at the same slot (order 30):
// instead of floating the modal it opens the door-routed full-page surface,
// like every other door. "Extensions" per the D1 rename — "connector" survives
// only as the kind-name for launchable MCP entries inside the surface.
export function ExtensionsNavEntry({ collapsed }: SidebarNavEntryRenderProps) {
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const active = useWorkspaceStore((s) => s.activeGlobalSurface === 'extensions')
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<ExtensionsNavIcon className="icon-sm pointer-events-none shrink-0" />}
      label="Extensions"
      ariaLabel="Extensions"
      tooltip="Extensions"
      tooltipWhenExpanded
      active={active}
      onClick={() => {
        // A plain open lands on the door's default view: discard any stale
        // deep-link latch a closed-before-mount door left behind.
        consumePendingExtensionsSurfaceTarget()
        openGlobalSurface('extensions')
      }}
    />
  )
}

// Link glyph, moved with the entry from WorkspaceSidebar — a connector is a
// link to an external service (matches the icon family's 16-box round-stroke
// idiom).
function ExtensionsNavIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M6.6 9.4L9.4 6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M8.7 4.6l.9-.9a2.3 2.3 0 0 1 3.3 3.3l-1.4 1.4a2.3 2.3 0 0 1-3.3 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.3 11.4l-.9.9a2.3 2.3 0 0 1-3.3-3.3l1.4-1.4a2.3 2.3 0 0 1 3.3 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
