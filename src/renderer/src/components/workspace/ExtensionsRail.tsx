import React, { useEffect, useMemo, useState } from 'react'

import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import type { RegisteredSidebarNavEntry } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SidebarNavButton } from './SidebarNavButton'

// The sidebar column's Extensions section (app shell, 2026-09-05): the
// list Slack's "More → Tools" sidebar is, for this product. One flat list of
// everything a person can open that is not a chat — the module-contributed
// doors (Sprints, Reviews, …) and the modal surfaces (Plugins, Automations,
// Design) — in registry order, with the same row chrome for both. Before this,
// the doors sat in a band above the workspaces tree and the modal surfaces
// hid as glyphs beside the Settings gear; a person had to know two homes for
// one idea.
//
// No heading and no groups: a heading must separate something from something
// else (principles, Composition), and to the person these are all just
// extensions. Sorted by each entry's declared `order`, doors and modals
// interleaved, so a module can place its surface where it belongs rather than
// in whichever registry it happened to use.
//
// A door row opens its full-page surface, whose rail then REPLACES this column
// for the door's visit (context-rail pattern); the host's back chevron or the
// Home glyph brings the column back. A modal row floats its surface over
// whatever owns the card region and stays pressed while it is open.

type ExtensionsRailProps = {
  collapsed: boolean
  // The module-contributed door entries, enablement-filtered by the sidebar.
  navEntries: readonly RegisteredSidebarNavEntry[]
}

export function ExtensionsRail({ collapsed, navEntries }: ExtensionsRailProps) {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const activeModalSurface = useWorkspaceStore((s) => s.activeModalSurface)
  const openModalSurface = useWorkspaceStore((s) => s.openModalSurface)
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
    const doorRows = navEntries.map((entry) => ({
      id: `door:${entry.id}`,
      order: entry.order,
      node: (
        <React.Suspense fallback={null}>
          <entry.Component collapsed={collapsed} />
        </React.Suspense>
      ),
    }))
    const modalRows = modalSurfaces.map((surface) => ({
      id: `modal:${surface.id}`,
      order: surface.order,
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
    }))
    return [...doorRows, ...modalRows].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }, [activeModalSurface, collapsed, modalSurfaces, navEntries, openModalSurface])

  return (
    <div role="list" aria-label="Extensions" className="mx-2 mt-1 flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.id} role="listitem" className="flex flex-col">
          {row.node}
        </div>
      ))}
    </div>
  )
}
