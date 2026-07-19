import React from 'react'

import { RoadmapBoard } from '../../panels/RoadmapSurface'
import { GlobalSurfaceShell } from './GlobalSurfaceShell'

// The Roadmap tenant of the door-routed full-page surface (global-surfaces epic
// 1704, first tenant). Registered by the roadmap module and mounted by
// WorkspaceManager over the workspace card region when the Roadmap door opens
// it — no scrim, no 1080×760 card. It hosts the existing instance-global
// `RoadmapBoard` full-page: the board still carries its own header, waiting-on-you
// strip, and steering columns, so the shell wraps it canvas-only. The roadmap-page
// rebuild (T2) lifts that header into the shell's surface bar and adds the
// roadmaps rail; the board/planner/orchestrator underneath carry over unchanged.
//
// No `onClose` is passed: this is a page, not a dialog. The board's own
// navigation (opening a backlog item, focusing a running sprint) activates a
// workspace, which clears the active surface and returns the card region.
export default function RoadmapGlobalSurface(): JSX.Element {
  return (
    <GlobalSurfaceShell ariaLabel="Roadmap">
      <RoadmapBoard />
    </GlobalSurfaceShell>
  )
}
