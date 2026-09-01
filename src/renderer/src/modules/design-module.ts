import React from 'react'

import type { RendererModule } from './renderer-host'
import { DesignGlyph } from '../components/workspace/modalSurfaceGlyphs'

// The Design surface, mounted in the shell's modal shell (doors→modals,
// 2026-09-01). Lazy — and deliberately NOT a top-level import — because it
// reaches the workspace store (and, through it, the FlexLayout graph); keeping
// it behind a dynamic import leaves the eager module-registry graph
// store-free, the discipline every other surface follows. The trigger glyph
// IS eager, and is a store-free leaf.
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
    // The Design modal (doors→modals, 2026-09-01; the order-35 top-nav door
    // before that): trigger glyph last in the settings cluster before the
    // gear, surface in the shell's modal shell.
    host.registerModalSurface({
      id: 'design',
      order: 30,
      label: 'Design',
      Icon: DesignGlyph,
      Component: DesignGlobalSurface,
    })
  },
}
