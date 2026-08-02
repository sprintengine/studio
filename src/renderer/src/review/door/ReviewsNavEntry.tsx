import type { SidebarNavEntryRenderProps } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SidebarNavButton } from '../../components/workspace/SidebarNavButton'

// The Reviews top-nav door (MC-1708 T6), contributed by the `review` capability
// module through the sidebar-nav host contribution point (order 50, after Roadmap
// per the mockup sidebar order). The sidebar renders it only while the module is
// enabled, so this assumes it is live: it opens the instance-global Reviews
// surface (mounted by WorkspaceManager, like Roadmap) against this window's store.
// One selected thing in the sidebar — opening the door deselects the project row.
export function ReviewsNavEntry({ collapsed }: SidebarNavEntryRenderProps) {
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const active = useWorkspaceStore((s) => s.activeGlobalSurface === 'reviews')
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<ReviewsNavIcon className="icon-sm pointer-events-none shrink-0" />}
      label="Reviews"
      ariaLabel="Reviews"
      tooltip="Reviews"
      active={active}
      onClick={() => openGlobalSurface('reviews')}
    />
  )
}

// The Reviews door glyph — an eye, matching the mockup's Reviews sidebar icon, in
// the icon family's 16-box round-stroke idiom.
function ReviewsNavIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
