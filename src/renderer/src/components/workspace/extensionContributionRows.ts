import type { RegisteredGlobalSurface } from '../../modules/renderer-host'
import { DRAWER_ROWS, EXTENSIONS_HOME_SURFACE_ID } from './extensionsDrawer'

const FIXED_SURFACE_IDS = new Set(
  DRAWER_ROWS.map((row) => (row.kind === 'nav' ? row.entryId : row.surfaceId)),
)

// Automations has its own app-rail square. The home is shell-owned. Everything
// else that was not claimed by a fixed product row is an installed extension's
// door and needs a route into the Extensions drawer.
const NON_CONTRIBUTION_SURFACE_IDS = new Set([EXTENSIONS_HOME_SURFACE_ID, 'automations'])

export type ExtensionContributionRow = {
  key: string
  rowId: null
  surfaceId: string
  viewId?: string
  label: string
  Icon: NonNullable<RegisteredGlobalSurface['Icon']>
  active: boolean
  open: () => void
}

export function extensionContributionRows({
  surfaces,
  activeGlobalSurface,
  activeView,
  enterExtensions,
  openGlobalSurface,
}: {
  surfaces: readonly RegisteredGlobalSurface[]
  activeGlobalSurface: string | null
  activeView: string | null
  enterExtensions: () => void
  openGlobalSurface: (surfaceId: string) => void
}): ExtensionContributionRow[] {
  return surfaces.flatMap((surface): ExtensionContributionRow[] => {
    if (FIXED_SURFACE_IDS.has(surface.id) || NON_CONTRIBUTION_SURFACE_IDS.has(surface.id)) return []

    if (surface.views?.length) {
      return surface.views.map((view) => ({
        key: `contribution-view:${surface.id}:${view.id}`,
        rowId: null,
        surfaceId: surface.id,
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
    return [{
      key: `contribution-surface:${surface.id}`,
      rowId: null,
      surfaceId: surface.id,
      label: surface.label,
      Icon: surface.Icon,
      active: activeGlobalSurface === surface.id,
      open: () => {
        surface.onOpen?.()
        enterExtensions()
        openGlobalSurface(surface.id)
      },
    }]
  })
}
