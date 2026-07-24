import React from 'react'

import type { SidebarNavEntryRenderProps } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { StatusDot } from '../ui/StatusDot'
import { useRoadmapAttention, type RoadmapAttention } from '../panels/roadmapBoard/roadmapBoardData'
import { SidebarNavButton } from './SidebarNavButton'

// The Roadmap top-nav door, contributed by the `roadmap` capability module
// through the sidebar-nav host contribution point. The sidebar renders it only
// while the module is enabled (the module declares dependsOn sprint-engine +
// automations, so the door disappears when either is off), so this component
// assumes it is live: it opens the instance-global surface (mounted by
// WorkspaceManager, like Connectors) against THIS window's store, and carries the
// orchestrator's waiting-on-you / running-sprint signal into the rail even while
// the surface is closed.
export function RoadmapNavEntry({ collapsed }: SidebarNavEntryRenderProps) {
  const openRoadmapSurface = useWorkspaceStore((s) => s.openRoadmapSurface)
  // The door is selected while its full-page surface owns the card region
  // (global-surfaces epic 1704): one selected thing in the sidebar, a door XOR a
  // project. openRoadmapSurface now routes to that surface, not the old overlay.
  const roadmapSurfaceActive = useWorkspaceStore((s) => s.activeGlobalSurface === 'roadmap')
  const attention = useRoadmapAttention(true)
  return (
    <SidebarNavButton
      collapsed={collapsed}
      icon={<RoadmapNavIcon className="icon-sm pointer-events-none shrink-0" />}
      label="Horizon"
      ariaLabel="Horizon"
      tooltip={attention.waiting ? 'Horizon — waiting on you' : 'Horizon'}
      tooltipWhenExpanded
      active={roadmapSurfaceActive}
      indicator={roadmapNavIndicator(attention)}
      onClick={() => openRoadmapSurface()}
    />
  )
}

// Horizon glyph for the top-nav entry — a sun setting on the horizon line, in
// the icon family's 16-box round-stroke idiom.
function RoadmapNavIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      {/* Sun dome resting on the horizon */}
      <path d="M4.8 11 a3.2 3.2 0 0 1 6.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Horizon line */}
      <path d="M2 11 H14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Low-sun rays */}
      <path d="M8 5.4 V3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4.2 6.8 3.2 5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.8 6.8 12.8 5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// The Roadmap nav dot: waiting-on-you takes precedence (a warn dot the user should
// act on) over the live-sprint pulse (an accent dot that is merely informational).
function roadmapNavIndicator(attention: RoadmapAttention): React.ReactNode {
  if (attention.waiting) return <StatusDot tone="warn" label="Horizon is waiting on you" />
  if (attention.running) return <StatusDot tone="accent" pulse label="A Horizon sprint is running" />
  return null
}
