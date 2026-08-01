import React, { useEffect, useState } from 'react'

import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import { COMING_SOON_MODULE_MANIFESTS } from '../../modules'
import { PrimaryButton } from '../ui'

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
  onOpenMarketplace,
}: {
  label: string
  onOpenMarketplace: () => void
}) {
  return (
    <div
      role="note"
      aria-label="Module not installed"
      className="flex h-full flex-col items-center justify-center gap-3 bg-[color:var(--bg-app)] px-6 text-center"
    >
      <p className="text-meta font-semibold text-[color:var(--text-strong)]">{label} isn’t installed</p>
      <p className="max-w-sm text-micro leading-5 text-[color:var(--text-muted)]">
        This workspace needs the {label} module. Your work here is safe on disk — install the module
        and the workspace opens right where you left it.
      </p>
      <PrimaryButton size="sm" onClick={onOpenMarketplace}>
        Find it in Connectors
      </PrimaryButton>
    </div>
  )
}

// A layout tab whose owning module is missing: host panel component ids are
// namespaced `<moduleId>.<panel>`, so the prefix names the module to offer.
// Only a prefix matching a known marketplace module entry upgrades to the
// install affordance; anything else (stale/unknown tabs, non-marketplace ids)
// keeps the caller's generic fallback.
export function marketplaceModuleForComponent(
  componentId: string,
  plugins: ReadonlyArray<Pick<MarketplacePluginEntry, 'id' | 'name' | 'provides'>>
): { id: string; name: string } | null {
  const dot = componentId.indexOf('.')
  if (dot <= 0) return null
  const moduleId = componentId.slice(0, dot)
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
