// The roadmap steering board as a workspace-mode panel. The roadmap is now
// instance-global (one plan per Multicode, MC-1688/1689): its real home is the
// sidebar Roadmap door (RoadmapSurface). This workspace-mode entry is retained only
// until the roadmap workspace mode is retired (T5); it renders the SAME board body as
// the surface — instance-global, self-deriving its home project — so opening a
// roadmap workspace shows the one instance roadmap, not a per-folder scope.

import React from 'react'

import { RoadmapBoard } from './RoadmapSurface'

export default function RoadmapBoardPanel(): JSX.Element {
  return <RoadmapBoard />
}
