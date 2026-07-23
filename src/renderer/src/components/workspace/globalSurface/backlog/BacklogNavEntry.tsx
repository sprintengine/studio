import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { SidebarNavButton } from '../../SidebarNavButton'

// The Backlog top-nav door (T9), contributed by the `backlog` capability module
// at order 25 — immediately after Sprints, matching the mockup §4 sidebar order
// (Automations → Sprints → Backlog → Roadmap → Reviews). It opens the
// instance-global Backlog surface against THIS window's store; the per-project
// Backlog panel inside a workspace stays exactly as it was.
//
// No attention dot (owner ruling 2026-07-24): backlog items are captured work,
// not live processes — a needs_input frontmatter value is a triage lens, and a
// standing amber dot on the nav row read as noise. Where something genuinely
// waits on a person, the surfaces themselves say so.
export function BacklogNavEntry({ collapsed }: SidebarNavEntryRenderProps) {
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const active = useWorkspaceStore((s) => s.activeGlobalSurface === 'backlog')
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<BacklogNavIcon className="icon-sm pointer-events-none shrink-0" />}
      label="Backlog"
      ariaLabel="Backlog"
      tooltip="Backlog"
      active={active}
      onClick={() => openGlobalSurface('backlog')}
    />
  )
}

// The Backlog door glyph — the stacked-lines list mark from the mockup §4
// sidebar, in the icon family's 16-box round-stroke idiom.
function BacklogNavIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
