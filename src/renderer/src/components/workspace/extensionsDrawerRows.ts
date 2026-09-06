import { useEffect, useMemo, useState } from 'react'

import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import type {
  RegisteredGlobalSurface,
  RegisteredSidebarNavEntry,
  SidebarNavEntryComponent,
  SurfaceIconComponent,
} from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { DRAWER_ROWS } from './extensionsDrawer'
import { useSurfaceView } from './surfaceView'

// The drawer's five rows, RESOLVED (Extensions drawer ruling, 2026-09-05,
// Stage 3). `extensionsDrawer.ts` says which rows exist and in what order;
// this says what each one currently IS against the live registry — its name,
// its glyph, whether the card region is showing it, and what clicking it does.
//
// It exists because the rows are now offered in two places. The drawer column
// lists them, and the Extensions home lists the same five as tiles, and the
// ruling is explicit that a tile "opens the same surface the drawer row does".
// Two resolvers would be two routings: the day a view row's deep-link latch
// changed, the tile would keep opening the old way and only one of the two
// would be found in testing. So the routing is written once, here, and both
// surfaces render what it returns.
//
// Not in `extensionsDrawer.ts` on purpose: that file is a leaf the store reads
// (settingsSlice), and this one reaches React and the workspace store.

export type ExtensionsDrawerRowView = {
  /** Stable across renders and unique in the list; a React key. */
  key: string
  /** The surface the row leads to. */
  surfaceId: string
  /** The view within it, when the row is one of a multi-row surface's views. */
  viewId?: string
  /**
   * The row's name and glyph, as the owning module declares them. Absent when
   * a door names itself through its own nav-entry component instead (Sprints
   * did until Stage 3); a caller that can only draw a generic row skips those.
   */
  label?: string
  Icon?: SurfaceIconComponent
  /**
   * The module's own row component, for a row contributed as a sidebar nav
   * entry. It owns its full chrome — a status dot, its own reading of
   * "selected" — so the drawer renders THIS rather than a generic row.
   */
  navComponent?: SidebarNavEntryComponent
  /**
   * The card region is showing exactly this row's destination. For a nav row
   * the module's own component owns the richer reading (Sprints also reads
   * selected while the operator is inside a run's terminals), so this stays the
   * plain one and the drawer does not use it there.
   */
  active: boolean
  /** Open this row's destination — the one routing both the drawer and the home use. */
  open: () => void
}

/**
 * @param navEntries the sidebar's already-enablement-filtered nav entries. The
 * drawer passes the list it was handed; a caller with no such list (the
 * Extensions home) omits it and the host is read with the same filter.
 */
export function useExtensionsDrawerRows(
  navEntries?: readonly RegisteredSidebarNavEntry[],
): ExtensionsDrawerRowView[] {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const activeGlobalSurface = useWorkspaceStore((s) => s.activeGlobalSurface)
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  // Which view the OPEN surface is standing on, so exactly one of a
  // multi-view surface's rows reads selected — including when the person moved
  // with the surface's own rail rather than by clicking a row. Only the open
  // surface can own a selected row, so one subscription answers for the whole
  // list.
  const activeView = useSurfaceView(activeGlobalSurface ?? '')
  // Third-party renderer modules can finish loading after first render (the
  // boot timeout race WorkspaceManager's moduleRegistryGeneration handles):
  // without this bump an SDK module's registerGlobalSurface would mount fine
  // but its row — the only user-visible way in — would stay absent until an
  // unrelated module toggle or a reload.
  const [registryGeneration, setRegistryGeneration] = useState(0)
  useEffect(
    () => onThirdPartyRendererModulesLoaded(() => setRegistryGeneration((n) => n + 1)),
    [],
  )
  const globalSurfaces = useMemo(
    () => getRendererHost().getGlobalSurfaces((id) => selectModuleEnabled(moduleOverrides, id)),
    [moduleOverrides, registryGeneration],
  )
  const hostNavEntries = useMemo(
    () => getRendererHost().getSidebarNavEntries((id) => selectModuleEnabled(moduleOverrides, id)),
    [moduleOverrides, registryGeneration],
  )
  const entries = navEntries ?? hostNavEntries

  return useMemo(() => {
    const surfaceById = new Map<string, RegisteredGlobalSurface>(
      globalSurfaces.map((surface) => [surface.id, surface]),
    )
    const entryById = new Map<string, RegisteredSidebarNavEntry>(
      entries.map((entry) => [entry.id, entry]),
    )
    return DRAWER_ROWS.flatMap((row): ExtensionsDrawerRowView[] => {
      if (row.kind === 'nav') {
        const entry = entryById.get(row.entryId)
        if (!entry) return []
        // A nav row's entry id IS its surface id (the door contract), so the
        // module's `registerGlobalSurface` is where its name and glyph live
        // even though the drawer draws neither — the home's tile needs both.
        const surface = surfaceById.get(entry.id)
        return [
          {
            key: `nav:${entry.id}`,
            surfaceId: entry.id,
            label: surface?.label,
            Icon: surface?.Icon,
            navComponent: entry.Component,
            active: activeGlobalSurface === entry.id,
            // The same call the module's own row makes. It is a plain open —
            // a nav door has no view to latch — so nothing precedes it.
            open: () => openGlobalSurface(entry.id),
          },
        ]
      }
      const surface = surfaceById.get(row.surfaceId)
      // A door with no label or glyph names itself through its own nav-entry
      // component and cannot be drawn as a generic row.
      if (!surface?.label || !surface.Icon) return []
      if (row.kind === 'surface') {
        return [
          {
            key: `surface:${surface.id}`,
            surfaceId: surface.id,
            label: surface.label,
            Icon: surface.Icon,
            active: activeGlobalSurface === surface.id,
            open: () => {
              // A plain open lands on the surface's default view: the surface
              // discards any stale deep-link latch in `onOpen` first.
              surface.onOpen?.()
              openGlobalSurface(surface.id)
            },
          },
        ]
      }
      const view = surface.views?.find((candidate) => candidate.id === row.viewId)
      if (!view) return []
      return [
        {
          key: `view:${surface.id}:${view.id}`,
          surfaceId: surface.id,
          viewId: view.id,
          label: view.label,
          Icon: view.Icon,
          // Selected while the surface is open ON THIS VIEW — not merely while
          // it is open, which would light all three of its rows.
          active: activeGlobalSurface === surface.id && activeView === view.id,
          open: () => {
            // The view latches its target first and the shell opens second,
            // the order every deep-link opener uses: the surface drains the
            // latch as it mounts, so an already-open surface and a cold one
            // both land on the row that was clicked.
            view.open()
            openGlobalSurface(surface.id)
          },
        },
      ]
    })
  }, [activeGlobalSurface, activeView, entries, globalSurfaces, openGlobalSurface])
}
