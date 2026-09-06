import React, { useEffect, useMemo, useState } from 'react'

import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import type { RegisteredModalSurface, RegisteredSidebarNavEntry } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useModalSurfaceView } from './modalSurfaceView'
import { SidebarNavButton } from './SidebarNavButton'

// The Extensions drawer (app shell, 2026-09-05): the sidebar column
// while the app rail's Extensions glyph is chosen. Everything a person can open
// that is not a chat and is not one of the product's own standing tools — the
// things ADDED to the product — in one column with one row chrome.
//
// FIVE rows, in a fixed order the owner ruled (2026-09-05):
//
//   Sprints · Design · Plugins · Skills · Agent CLIs
//
// Registry `order` no longer decides. The earlier cut sorted doors and modal
// surfaces together by their declared `order`, which meant the column a person
// reads top to bottom was arranged by whichever numbers modules happened to
// claim, and any module registered later could push Sprints down it. The order
// of the product's parts is a ruling; the list below is that ruling, and each
// entry names only WHERE its row comes from — the owning module still supplies
// the label, the glyph and what opening the row does.
//
// A row whose module is disabled simply is not there: every lookup below goes
// through the host's enablement filter, and a miss renders nothing rather than
// a dead row. The drawer STAYS PUT while the card region swaps; only Sprints,
// which has its own list of runs, replaces this column with its rail for the
// length of its visit (context-rail pattern), and the host's back chevron or a
// rail glyph brings the drawer back.
//
// No heading and no groups: a heading must separate something from something
// else (principles, Composition), and to the person these are all just
// extensions.

// Where a row comes from. Three kinds, because the registry has three shapes of
// contribution and the drawer must not flatten them into one hand-written list
// of components:
//   door    — a module's `registerSidebarNavEntry` row (Sprints), which owns its
//             own status dot and open behaviour.
//   surface — a module's `registerModalSurface` (Design), one row for the whole
//             surface.
//   view    — one of a surface's registered `views` (renderer-host): the single
//             `extensions` surface is Plugins, Skills and Agent CLIs to the
//             person, so it contributes three rows, each with its own label,
//             glyph and way of landing the surface on it.
type DrawerRow =
  | { kind: 'door'; entryId: string }
  | { kind: 'surface'; surfaceId: string }
  | { kind: 'view'; surfaceId: string; viewId: string }

const DRAWER_ROWS: readonly DrawerRow[] = [
  { kind: 'door', entryId: 'sprints' },
  { kind: 'surface', surfaceId: 'design' },
  { kind: 'view', surfaceId: 'extensions', viewId: 'plugins' },
  { kind: 'view', surfaceId: 'extensions', viewId: 'skills' },
  { kind: 'view', surfaceId: 'extensions', viewId: 'agent-clis' },
]

type ExtensionsRailProps = {
  collapsed: boolean
  // The module-contributed door entries, enablement-filtered by the sidebar.
  navEntries: readonly RegisteredSidebarNavEntry[]
}

export function ExtensionsRail({ collapsed, navEntries }: ExtensionsRailProps) {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const activeModalSurface = useWorkspaceStore((s) => s.activeModalSurface)
  const openModalSurface = useWorkspaceStore((s) => s.openModalSurface)
  // Which view the OPEN surface is standing on, so exactly one of a
  // multi-view surface's rows reads selected — including when the person moved
  // with the surface's own rail rather than by clicking a row here. Only the
  // open surface can own a selected row, so one subscription answers for the
  // whole column.
  const activeView = useModalSurfaceView(activeModalSurface ?? '')
  // Third-party renderer modules can finish loading after first render (the
  // boot timeout race WorkspaceManager's moduleRegistryGeneration handles):
  // without this bump an SDK module's registerModalSurface would mount fine
  // but its row — the only user-visible way in — would stay absent until an
  // unrelated module toggle or a reload.
  const [registryGeneration, setRegistryGeneration] = useState(0)
  useEffect(
    () => onThirdPartyRendererModulesLoaded(() => setRegistryGeneration((n) => n + 1)),
    [],
  )
  const modalSurfaces = useMemo(
    () => getRendererHost().getModalSurfaces((id) => selectModuleEnabled(moduleOverrides, id)),
    [moduleOverrides, registryGeneration],
  )

  const rows = useMemo(() => {
    const surfaceById = new Map<string, RegisteredModalSurface>(
      modalSurfaces.map((surface) => [surface.id, surface]),
    )
    const entryById = new Map<string, RegisteredSidebarNavEntry>(
      navEntries.map((entry) => [entry.id, entry]),
    )
    return DRAWER_ROWS.flatMap((row) => {
      if (row.kind === 'door') {
        const entry = entryById.get(row.entryId)
        if (!entry) return []
        return [
          {
            key: `door:${entry.id}`,
            node: (
              <React.Suspense fallback={null}>
                <entry.Component collapsed={collapsed} />
              </React.Suspense>
            ),
          },
        ]
      }
      const surface = surfaceById.get(row.surfaceId)
      if (!surface) return []
      if (row.kind === 'surface') {
        return [
          {
            key: `modal:${surface.id}`,
            node: (
              <SidebarNavButton
                collapsed={collapsed}
                icon={<surface.Icon className="icon-sm pointer-events-none shrink-0" />}
                label={surface.label}
                ariaLabel={surface.label}
                tooltip={surface.label}
                active={activeModalSurface === surface.id}
                onClick={() => {
                  // A plain open lands on the surface's default view: the surface
                  // discards any stale deep-link latch in `onOpen` first.
                  surface.onOpen?.()
                  openModalSurface(surface.id)
                }}
              />
            ),
          },
        ]
      }
      const view = surface.views?.find((candidate) => candidate.id === row.viewId)
      if (!view) return []
      return [
        {
          key: `view:${surface.id}:${view.id}`,
          node: (
            <SidebarNavButton
              collapsed={collapsed}
              icon={<view.Icon className="icon-sm pointer-events-none shrink-0" />}
              label={view.label}
              ariaLabel={view.label}
              tooltip={view.label}
              // Selected while the surface is open ON THIS VIEW — not merely
              // while it is open, which would light all three of its rows.
              active={activeModalSurface === surface.id && activeView === view.id}
              onClick={() => {
                // The view latches its target first and the shell opens second,
                // the order every deep-link opener uses: the surface drains the
                // latch as it mounts, so an already-open surface and a cold one
                // both land on the row that was clicked.
                view.open()
                openModalSurface(surface.id)
              }}
            />
          ),
        },
      ]
    })
  }, [activeModalSurface, activeView, collapsed, modalSurfaces, navEntries, openModalSurface])

  return (
    <div role="list" aria-label="Extensions" className="mx-2 mt-1 flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.key} role="listitem" className="flex flex-col">
          {row.node}
        </div>
      ))}
    </div>
  )
}
