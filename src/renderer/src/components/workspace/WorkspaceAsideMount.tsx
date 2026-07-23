import React, { useMemo } from 'react'

import { getRendererHost, selectModuleEnabled } from '../../modules'
import type { RegisteredWorkspaceAside } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { WorkspaceAsideColumn } from './workspaceAsideColumn'

// Store wiring for the workspace aside column (workspaceAsideColumn.tsx owns the
// chrome). No module claims the column today — MC-1766 retired the Sprint
// Engines survey that used to live here and the Sprints door owns that view now
// — so this resolves to null, `workspaceAsideOpen` has no reachable setter, and
// nothing renders. The seam stays whole so the next tenant mounts without
// re-plumbing WorkspaceManager.

/**
 * The tenant to mount right now, or null when the column stays closed: nothing
 * registered, the owning module is disabled, or the open flag is false. Gating
 * on live enablement matches the door-surface mount — a stale flag from before
 * a module toggle can never strand an empty column.
 */
export function useWorkspaceAsideTenant(): RegisteredWorkspaceAside | null {
  const open = useWorkspaceStore((s) => s.workspaceAsideOpen)
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
  return useMemo(() => {
    if (!open) return null
    const tenant = getRendererHost().getWorkspaceAside()
    if (!tenant) return null
    return selectModuleEnabled(moduleEnablement, tenant.moduleId) ? tenant : null
  }, [open, moduleEnablement])
}

// The store-wired column WorkspaceManager renders once the seam resolves a
// tenant. Zero-prop tenants own their own data and close themselves through
// `setWorkspaceAsideOpen`, exactly like a door surface owns its own state.
export default function WorkspaceAsideMount({ tenant }: { tenant: RegisteredWorkspaceAside }) {
  const width = useWorkspaceStore((s) => s.workspaceAsideWidth)
  const setWidth = useWorkspaceStore((s) => s.setWorkspaceAsideWidth)
  return (
    <WorkspaceAsideColumn label={tenant.label} width={width} onWidthChange={setWidth}>
      <React.Suspense fallback={null}>
        <tenant.Component />
      </React.Suspense>
    </WorkspaceAsideColumn>
  )
}
