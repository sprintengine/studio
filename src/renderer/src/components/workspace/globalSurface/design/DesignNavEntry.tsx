import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { SidebarNavButton } from '../../SidebarNavButton'

// The Design top-nav door (item 2002), contributed by the bundled `design`
// module through the sidebar-nav host contribution point — the same seam the
// other six doors use, with no new mechanism.
//
// Order 35 puts it directly after Extensions (30): the work doors lead
// (Automations 10, Sprints 20, Backlog 25), the "what you build with" pair
// follows, and planning/review trail (Roadmap 40, Reviews 50).
export function DesignNavEntry({ collapsed }: SidebarNavEntryRenderProps) {
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const active = useWorkspaceStore((s) => s.activeGlobalSurface === 'design')
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<DesignNavIcon className="icon-sm pointer-events-none shrink-0" />}
      label="Design"
      ariaLabel="Design"
      tooltip="Design"
      tooltipWhenExpanded
      active={active}
      onClick={() => openGlobalSurface('design')}
    />
  )
}

// Overlapping swatches: a design system is a set of decided values, and the
// stack reads as "several, related" without borrowing the palette/brush
// vocabulary of a drawing tool — this door renders systems, it does not author
// them.
function DesignNavIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect
        x="2.2"
        y="2.2"
        width="7"
        height="7"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M11.2 6.8h2a.8.8 0 0 1 .8.8v5.2a.8.8 0 0 1-.8.8H7.6a.8.8 0 0 1-.8-.8v-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
