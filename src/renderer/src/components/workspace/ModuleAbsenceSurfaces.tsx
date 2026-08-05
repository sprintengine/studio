import React, { useEffect, useState } from 'react'

import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import { ACTIVE_RENDERER_MODULE_MANIFESTS, COMING_SOON_MODULE_MANIFESTS } from '../../modules'
import { getThirdPartyRendererLoadState } from '../../modules/third-party-loader'
import { EmptyState, PrimaryButton } from '../ui'

// Explicit absence surfaces for module-owned UI (MC-1532). A workspace whose
// mode's module is not installed — fresh machine, uninstalled, marketplace
// install pending — must render a labeled state with an install path, never a
// blank pane or a grid of dead tabs. Data-safe by construction: nothing here
// mutates the workspace; installing the module renders it again.

// Last-known display label for a mode with no registered workspace type: the
// bundled-but-inactive (dev-only) manifests still know their names; anything
// else (a marketplace module) falls back to the capitalized mode id.
export function moduleLabelForMode(mode: string): string {
  const comingSoon = COMING_SOON_MODULE_MANIFESTS.find((manifest) => manifest.id === mode)
  if (comingSoon) return comingSoon.displayName
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

export function ModuleNotInstalledSurface({
  label,
  installed = false,
  onOpenMarketplace,
}: {
  label: string
  /** True when the module is on the machine but disabled — the copy stays honest. */
  installed?: boolean
  onOpenMarketplace: () => void
}) {
  // The kit's empty state (MC-2115/MC-2117): this and the door surface below
  // were their own dialect — `text-meta` title, `text-micro` body, and one of
  // them painting `bg-app` while the other painted nothing. The wrapper keeps
  // the `role="note"` labelling, which is this surface's own contract.
  return (
    <div role="note" aria-label="Module not installed" className="h-full bg-[color:var(--bg-app)]">
      <EmptyState
        title={installed ? `${label} is turned off` : `${label} isn’t installed`}
        body={
          installed
            ? `This workspace needs the ${label} module. Your work here is safe on disk — turn the module back on and the workspace opens right where you left it.`
            : `This workspace needs the ${label} module. Your work here is safe on disk — install the module and the workspace opens right where you left it.`
        }
        action={
          <PrimaryButton size="sm" onClick={onOpenMarketplace}>
            Find it in Connectors
          </PrimaryButton>
        }
      />
    </div>
  )
}

// A top-level door whose owning module is absent (MC-1854): the persisted
// `activeGlobalSurface` id names a surface that never registered (module not
// installed) or whose module is disabled. Same rule as the workspace surface
// above — a labeled state with an install path, never a blank pane — and the
// persisted id is never cleared: reinstalling lands the user back on this door.
export function DoorModuleNotInstalledSurface({
  label,
  installed = false,
  onOpenExtensions,
}: {
  label: string
  /** True when the module is on the machine but disabled — the copy stays honest. */
  installed?: boolean
  onOpenExtensions: () => void
}) {
  return (
    <div role="note" aria-label="Door module not installed" className="h-full">
      <EmptyState
        title={label}
        body={installed ? `The ${label} module is turned off.` : `The ${label} module isn’t installed.`}
        action={
          <PrimaryButton size="sm" onClick={onOpenExtensions}>
            Find it in Extensions
          </PrimaryButton>
        }
      />
    </div>
  )
}

// True when the module id is present in this session — a bundled module active
// in this build, or a third-party module the loader evaluated cleanly. A tab
// whose module is present is stale chrome (an old panel id), not a missing
// install, and must never claim "isn't installed".
function isModulePresent(moduleId: string): boolean {
  if (ACTIVE_RENDERER_MODULE_MANIFESTS.some((manifest) => manifest.id === moduleId)) return true
  return getThirdPartyRendererLoadState(moduleId)?.status === 'loaded'
}

// A layout tab whose owning module is missing: host panel component ids are
// namespaced `<moduleId>.<panel>`, so the prefix names the module to offer.
// Only a prefix that names an ABSENT module matching a known marketplace
// module entry upgrades to the install affordance; anything else (stale tabs
// of present modules, unknown ids, non-marketplace prefixes) keeps the
// caller's generic fallback.
export function marketplaceModuleForComponent(
  componentId: string,
  plugins: ReadonlyArray<Pick<MarketplacePluginEntry, 'id' | 'name' | 'provides'>>,
  isPresent: (moduleId: string) => boolean = isModulePresent
): { id: string; name: string } | null {
  const dot = componentId.indexOf('.')
  if (dot <= 0) return null
  const moduleId = componentId.slice(0, dot)
  if (isPresent(moduleId)) return null
  const entry = plugins.find((plugin) => plugin.id === moduleId && plugin.provides.includes('module'))
  return entry ? { id: entry.id, name: entry.name } : null
}

export function MissingModulePanelSurface({
  componentId,
  fallback,
  onOpenMarketplace,
}: {
  componentId: string
  // Rendered until (and unless) the component id resolves to a known
  // marketplace module — the existing "Panel unavailable" surface.
  fallback: React.ReactNode
  onOpenMarketplace: () => void
}) {
  const [moduleName, setModuleName] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (typeof window.api?.readMarketplaceRegistry !== 'function') return
    void window.api
      .readMarketplaceRegistry()
      .then((result) => {
        if (cancelled || !result.ok) return
        const match = marketplaceModuleForComponent(componentId, result.marketplace.plugins)
        if (match) setModuleName(match.name)
      })
      .catch(() => {
        // Registry unreachable — the generic fallback already covers the tab.
      })
    return () => {
      cancelled = true
    }
  }, [componentId])
  if (!moduleName) return <>{fallback}</>
  return <ModuleNotInstalledSurface label={moduleName} onOpenMarketplace={onOpenMarketplace} />
}
