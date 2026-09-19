// A second external module compiled against the packed tarball only: a
// top-level, instance-global door and nothing else. The owner-ruled
// first-class case — this module deliberately registers NO workspace type, NO
// panel, and no project-scoped contribution, so the published contract can
// never quietly grow a requirement that a door has an owning workspace.

import { createElement, lazy } from 'react'

import type {
  CapabilityManifest,
  GlobalSurfaceDefinition,
  RegisterRenderer,
  SidebarNavEntryDefinition,
  SidebarNavEntryRenderProps,
} from '@sprintengine/module-sdk'

export const manifest: CapabilityManifest = {
  id: 'tide-tables',
  displayName: 'Tide Tables',
  version: 1,
  publisher: 'example-author',
  summary: 'Instance-global tide charts behind a top-level door.',
  defaultEnabled: true,
  source: 'third-party',
  entry: {
    renderer: 'dist/renderer.mjs',
  },
}

// The door: a self-contained sidebar row whose open action routes to the
// surface id below. Bundled doors reserve orders 0–60.
const tideDoor: SidebarNavEntryDefinition = {
  id: 'tide-tables',
  order: 70,
  Component: ({ collapsed }: SidebarNavEntryRenderProps) =>
    createElement('button', null, collapsed ? 'T' : 'Tide Tables'),
}

// The page behind it, in the lazy form — proving the published Component type
// accepts React.lazy() exactly like SidebarNavEntryComponent does.
const tideSurface: GlobalSurfaceDefinition = {
  id: 'tide-tables',
  Component: lazy(async () => ({
    default: () => createElement('div', null, 'Tide tables'),
  })),
}

export const registerRenderer: RegisterRenderer = (host) => {
  host.registerSidebarNavEntry(tideDoor)
  host.registerGlobalSurface(tideSurface)
}
