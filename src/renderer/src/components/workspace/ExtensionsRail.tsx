import React, { useEffect, useMemo, useState } from 'react'

import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import type { RegisteredGlobalSurface, RegisteredSidebarNavEntry } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { DRAWER_ROWS } from './extensionsDrawer'
import { useSurfaceView } from './surfaceView'
import { SidebarNavButton } from './SidebarNavButton'

// The Extensions drawer (app shell, 2026-09-05): the sidebar column
// while the app rail's Extensions glyph is chosen. Everything a person can open
// that is not a chat and is not one of the product's own standing tools — the
// things ADDED to the product — in one column with one row chrome.
//
// The rows and their order are the ruling, held as data next door
// (`extensionsDrawer.ts`); this file only resolves each one against the live
// registry and renders it. A row whose module is disabled simply is not there:
// every lookup below goes through the host's enablement filter, and a miss
// renders nothing rather than a dead row.
//
// The drawer STAYS PUT while the card region swaps — that is what makes it the
// navigation rather than a menu (Stage 2 of the ruling). Its rows open DOORS
// now, not modals, and a door that is a drawer row declares `railPlacement:
// 'inline'` so it renders its own rail beside its canvas instead of taking this
// column. Only Sprints, whose rail is its own list of runs, still replaces this
// column for the length of its visit, and the host's back chevron or a rail
// glyph brings the drawer back.
//
// No heading and no groups: a heading must separate something from something
// else (principles, Composition), and to the person these are all just
// extensions.

type ExtensionsRailProps = {
  collapsed: boolean
  // The module-contributed door entries, enablement-filtered by the sidebar.
  navEntries: readonly RegisteredSidebarNavEntry[]
}

export function ExtensionsRail({ collapsed, navEntries }: ExtensionsRailProps) {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const activeGlobalSurface = useWorkspaceStore((s) => s.activeGlobalSurface)
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  // Which view the OPEN surface is standing on, so exactly one of a
  // multi-view surface's rows reads selected — including when the person moved
  // with the surface's own rail rather than by clicking a row here. Only the
  // open surface can own a selected row, so one subscription answers for the
  // whole column.
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

  const rows = useMemo(() => {
    const surfaceById = new Map<string, RegisteredGlobalSurface>(
      globalSurfaces.map((surface) => [surface.id, surface]),
    )
    const entryById = new Map<string, RegisteredSidebarNavEntry>(
      navEntries.map((entry) => [entry.id, entry]),
    )
    return DRAWER_ROWS.flatMap((row) => {
      if (row.kind === 'nav') {
        const entry = entryById.get(row.entryId)
        if (!entry) return []
        return [
          {
            key: `nav:${entry.id}`,
            node: (
              <React.Suspense fallback={null}>
                <entry.Component collapsed={collapsed} />
              </React.Suspense>
            ),
          },
        ]
      }
      const surface = surfaceById.get(row.surfaceId)
      // A door with no label or glyph names itself through its own nav-entry
      // component (Sprints) and cannot be drawn as a generic row here.
      if (!surface?.label || !surface.Icon) return []
      const { Icon } = surface
      if (row.kind === 'surface') {
        return [
          {
            key: `surface:${surface.id}`,
            node: (
              <SidebarNavButton
                collapsed={collapsed}
                icon={<Icon className="icon-sm pointer-events-none shrink-0" />}
                label={surface.label}
                ariaLabel={surface.label}
                tooltip={surface.label}
                active={activeGlobalSurface === surface.id}
                onClick={() => {
                  // A plain open lands on the surface's default view: the surface
                  // discards any stale deep-link latch in `onOpen` first.
                  surface.onOpen?.()
                  openGlobalSurface(surface.id)
                }}
              />
            ),
          },
        ]
      }
      const view = surface.views?.find((candidate) => candidate.id === row.viewId)
      if (!view) return []
      const ViewIcon = view.Icon
      return [
        {
          key: `view:${surface.id}:${view.id}`,
          node: (
            <SidebarNavButton
              collapsed={collapsed}
              icon={<ViewIcon className="icon-sm pointer-events-none shrink-0" />}
              label={view.label}
              ariaLabel={view.label}
              tooltip={view.label}
              // Selected while the surface is open ON THIS VIEW — not merely
              // while it is open, which would light all three of its rows.
              active={activeGlobalSurface === surface.id && activeView === view.id}
              onClick={() => {
                // The view latches its target first and the shell opens second,
                // the order every deep-link opener uses: the surface drains the
                // latch as it mounts, so an already-open surface and a cold one
                // both land on the row that was clicked.
                view.open()
                openGlobalSurface(surface.id)
              }}
            />
          ),
        },
      ]
    })
  }, [activeGlobalSurface, activeView, collapsed, globalSurfaces, navEntries, openGlobalSurface])

  return (
    // `aria-current`, not `aria-pressed`, on the selected row (SidebarNavButton's
    // `active`). These rows are NAVIGATION — each routes the card region to a
    // different page, and the lit one says where you are, exactly as the
    // workspaces tree's rows do. The app rail's Automations square is the other
    // reading on purpose: the rail is a fixed strip of chrome rather than a list
    // a person walks, and its square stays PRESSED while the tool it holds is up
    // (principles, "The app rail"). Same state, two honest readings; what would
    // be wrong is one row of this column disagreeing with the row above it.
    <div role="list" aria-label="Extensions" className="mx-2 mt-1 flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.key} role="listitem" className="flex flex-col">
          {row.node}
        </div>
      ))}
    </div>
  )
}
