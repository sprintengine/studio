import type { SidebarNavEntryRenderProps } from '../../../../modules/renderer-host'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { StatusDot } from '../../../ui/StatusDot'
import { SidebarNavButton } from '../../SidebarNavButton'
import { useAllProjectsBacklog } from '../../../../hooks/useAllProjectsBacklog'
import { anyProjectNeedsInput } from './backlogSurfaceModel'

// The Backlog top-nav door (T9), contributed by the `backlog` capability module
// at order 25 — immediately after Sprints, matching the mockup §4 sidebar order
// (Automations → Sprints → Backlog → Roadmap → Reviews). It opens the
// instance-global Backlog surface against THIS window's store; the per-project
// Backlog panel inside a workspace stays exactly as it was.
//
// The dot is the door's one honest signal: an item somewhere — in ANY open
// project — is waiting on a human. It rides the SAME shared cross-project scan
// the surface reads (no second scan, no poller), so opening the door can never
// disagree with the dot.
export function BacklogNavEntry({ collapsed }: SidebarNavEntryRenderProps) {
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const active = useWorkspaceStore((s) => s.activeGlobalSurface === 'backlog')
  const { projects } = useAllProjectsBacklog()
  const waiting = anyProjectNeedsInput(projects)
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<BacklogNavIcon className="icon-xs pointer-events-none shrink-0" />}
      label="Backlog"
      ariaLabel="Backlog"
      tooltip={waiting ? 'Backlog — an item needs input' : 'Backlog'}
      active={active}
      indicator={waiting ? <StatusDot tone="warn" size={6} label="An item needs input" /> : undefined}
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
