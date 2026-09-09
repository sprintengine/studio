// The host half of `@multicode/module-sdk/surface` (D6) — the door shell a
// module's modal or global surface renders inside, so a module-owned door is
// laid out, titled, back-navigated and empty-stated exactly like a bundled one
// instead of re-implementing the chrome a shade off.
//
// Same mechanism as sdk-ui.ts: the module marks the specifier external, the
// import map installed by third-party-loader.ts resolves it to this namespace.
// Loaded lazily; nothing eager may import it.

import type * as React from 'react'

export { GlobalSurfaceShell } from '../components/workspace/globalSurface/GlobalSurfaceShell'
export { useSurfaceBackNav } from '../components/workspace/globalSurface/surfaceBackNav'
export { SurfaceCanvasState, SurfaceRail } from '../components/workspace/globalSurface/surfaceSubstrate'

export type {
  GlobalSurfaceBar,
  GlobalSurfaceShellProps,
} from '../components/workspace/globalSurface/GlobalSurfaceShell'
export type {
  SurfaceCanvasStateProps,
  SurfaceRailFilter,
  SurfaceRailGroup,
  SurfaceRailNewAffordance,
  SurfaceRailRow,
  SurfaceRailScope,
  SurfaceRailSearch,
} from '../components/workspace/globalSurface/surfaceSubstrate'

import type { SurfaceRail } from '../components/workspace/globalSurface/surfaceSubstrate'

// SurfaceRail declares its props inline, so the published name is derived here
// rather than added to the app component's own exports.
export type SurfaceRailProps = React.ComponentProps<typeof SurfaceRail>
