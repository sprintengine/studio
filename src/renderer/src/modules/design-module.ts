import React from 'react'

import type { RendererModule } from './renderer-host'
import { DesignGlyph } from '../components/workspace/surfaceGlyphs'

// The Design surface, mounted over the workspace card region as a door
// (Extensions drawer ruling, 2026-09-05; a modal from 2026-09-01 until then).
// Lazy — and deliberately NOT a top-level import — because it
// reaches the workspace store (and, through it, the FlexLayout graph); keeping
// it behind a dynamic import leaves the eager module-registry graph
// store-free, the discipline every other surface follows. The trigger glyph
// IS eager, and is a store-free leaf.
const DesignGlobalSurface = React.lazy(
  () => import('../components/workspace/globalSurface/design/DesignGlobalSurface'),
)

// The `design` renderer module (epic `design-door`, item 2002).
//
// The Design Wizard — a separate feature that AUTHORED design systems through a
// specialist interview — was deleted 2026-09-08. This door was never part of it:
// it RENDERS systems you already have, from wherever they came, and seeds new
// bundles from the shipped templates.
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
    // The Design door: the second row of the Extensions drawer, and a
    // card-region surface (Extensions drawer ruling, 2026-09-05 — "surfaces,
    // not modals"). It was a top-nav door until 2026-09-01, a modal until this
    // ruling, and is a door again; the id never moved, so every deep link and
    // every persisted `activeGlobalSurface` survived both trips.
    //
    // `railPlacement: 'inline'` because Design IS a drawer row: its own rail
    // (the design systems it can show) renders beside its canvas, and the
    // drawer stays in the sidebar column as the navigation that reached it.
    host.registerGlobalSurface({
      id: 'design',
      label: 'Design',
      Icon: DesignGlyph,
      railPlacement: 'inline',
      Component: DesignGlobalSurface,
    })
  },
}
