import React from 'react'

import type { RendererModule } from './renderer-host'

// The Design door + its full-page surface. Lazy — and deliberately NOT top-level
// imports — because both reach the workspace store (and, through it, the
// FlexLayout graph); keeping them behind dynamic imports leaves the eager
// module-registry graph store-free, the discipline every other door follows.
const DesignNavEntry = React.lazy(() =>
  import('../components/workspace/globalSurface/design/DesignNavEntry').then((module) => ({
    default: module.DesignNavEntry,
  })),
)
const DesignGlobalSurface = React.lazy(
  () => import('../components/workspace/globalSurface/design/DesignGlobalSurface'),
)

// The `design` renderer module (epic `design-door`, item 2002).
//
// **This is not the Design Wizard.** Owner ruling 2026-07-30: the Design door and
// the Design Wizard (`design-wizard`, MC-1860) are entirely separate things and
// must not be conflated. The Wizard is an authoring flow that PRODUCES design
// systems; this door RENDERS systems you already have, from wherever they came.
// They share the design-system bundle substrate (`src/shared/design-system/`) as
// a dependency, which is not a reason to share an identity — so this module has
// no coupling to MC-1860 and does not wait on it.
//
// Order 35 seats the door directly after Extensions (30): the work doors lead
// (Automations 10, Sprints 20, Backlog 25), the "what you build with" pair
// follows, and planning/review trail (Roadmap 40, Reviews 50).
export const designRendererModule: RendererModule = {
  manifest: {
    id: 'design',
    displayName: 'Design',
    version: 1,
    publisher: 'multicode',
    category: 'insight',
    summary:
      'The Design door: see the design systems you have, rendered, and point at new ones on disk.',
    defaultEnabled: true,
  },
  registerRenderer(host) {
    host.registerSidebarNavEntry({ id: 'design', order: 35, Component: DesignNavEntry })
    host.registerGlobalSurface({ id: 'design', Component: DesignGlobalSurface })
  },
}
