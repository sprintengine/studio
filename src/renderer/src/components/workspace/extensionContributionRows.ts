import type {
  RegisteredGlobalSurface,
  RegisteredSidebarNavEntry,
  SidebarNavEntryComponent,
} from '../../modules/renderer-host'
import { DRAWER_ROWS, EXTENSIONS_HOME_SURFACE_ID } from './extensionsDrawer'

const FIXED_SURFACE_IDS = new Set(DRAWER_ROWS.map((row) => (row.kind === 'nav' ? row.entryId : row.surfaceId)))

// The home is shell-owned. Everything else that was not claimed by a fixed
// product row is an installed extension's door and needs a route into the
// Extensions drawer.
const NON_CONTRIBUTION_SURFACE_IDS = new Set([EXTENSIONS_HOME_SURFACE_ID])

// An installed door's row. Its `rowId` is its surface id — the one name its
// module's door badge, its `notify` targets and the drawer's selection share —
// carried by exactly one row per door: the door's only row, or the first of a
// multi-view door's rows, so a count is worn once rather than once per view.
// A module that registered a sidebar nav entry under the surface's id draws
// that row itself (`navComponent`), in place of the generic one.
export type ExtensionContributionRow = {
  key: string
  rowId: string | null
  surfaceId: string
  moduleId: string
  viewId?: string
  label?: string
  Icon?: RegisteredGlobalSurface['Icon']
  navComponent?: SidebarNavEntryComponent
  active: boolean
  open: () => void
}

export function extensionContributionRows({
  surfaces,
  navEntries = [],
  activeGlobalSurface,
  activeView,
  enterExtensions,
  openGlobalSurface,
}: {
  surfaces: readonly RegisteredGlobalSurface[]
  /** Enabled modules' nav entries; one whose id is its own module's surface id draws that door's row. */
  navEntries?: readonly RegisteredSidebarNavEntry[]
  activeGlobalSurface: string | null
  activeView: string | null
  enterExtensions: () => void
  openGlobalSurface: (surfaceId: string) => void
}): ExtensionContributionRow[] {
  const navEntryById = new Map(navEntries.map((entry) => [entry.id, entry]))
  return surfaces.flatMap((surface): ExtensionContributionRow[] => {
    if (FIXED_SURFACE_IDS.has(surface.id) || NON_CONTRIBUTION_SURFACE_IDS.has(surface.id)) return []

    // The door contract: a nav entry under the surface's own id, from the
    // module that owns the surface, IS the door's row. It replaces the generic
    // row (or the view rows) because it is the module's own drawing of the
    // same door — two rows would be two ways to the same place.
    const navEntry = navEntryById.get(surface.id)
    if (navEntry && navEntry.moduleId === surface.moduleId) {
      return [
        {
          key: `contribution-nav:${surface.id}`,
          rowId: surface.id,
          surfaceId: surface.id,
          moduleId: surface.moduleId,
          label: surface.label,
          Icon: surface.Icon,
          navComponent: navEntry.Component,
          active: activeGlobalSurface === surface.id,
          open: () => {
            surface.onOpen?.()
            enterExtensions()
            openGlobalSurface(surface.id)
          },
        },
      ]
    }

    if (surface.views?.length) {
      return surface.views.map((view, index) => ({
        key: `contribution-view:${surface.id}:${view.id}`,
        rowId: index === 0 ? surface.id : null,
        surfaceId: surface.id,
        moduleId: surface.moduleId,
        viewId: view.id,
        label: view.label,
        Icon: view.Icon,
        active: activeGlobalSurface === surface.id && activeView === view.id,
        open: () => {
          view.open()
          enterExtensions()
          openGlobalSurface(surface.id)
        },
      }))
    }

    if (!surface.label || !surface.Icon) return []
    return [
      {
        key: `contribution-surface:${surface.id}`,
        rowId: surface.id,
        surfaceId: surface.id,
        moduleId: surface.moduleId,
        label: surface.label,
        Icon: surface.Icon,
        active: activeGlobalSurface === surface.id,
        open: () => {
          surface.onOpen?.()
          enterExtensions()
          openGlobalSurface(surface.id)
        },
      },
    ]
  })
}
