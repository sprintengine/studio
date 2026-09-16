import React, { useCallback, useEffect, useState } from 'react'

import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import { ACTIVE_RENDERER_MODULE_MANIFESTS, COMING_SOON_MODULE_MANIFESTS } from '../../modules'
import { getThirdPartyRendererLoadState } from '../../modules/third-party-loader'
import {
  classifyVerification,
  deriveInstallView,
  summarizeInstallResult,
  type InstallFlowState,
} from '../settings/installFlow'
import { EmptyState, GhostButton, InlineNotice, PrimaryButton, Spinner, StatusDot } from '../ui'

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

/**
 * The display name of a module that IS on the machine, by id.
 *
 * Used by the turned-off surface, which reaches it through the registered
 * workspace type (`RegisteredWorkspaceTypeDefinition.moduleId`) rather than the
 * mode string: a module's id and the workspace-type id it registers need not
 * match — Sprint Engine's do not — so capitalizing the mode would name the
 * wrong thing. Falls back to the id when no manifest knows it, which is the
 * third-party case before its manifest is read.
 */
export function moduleLabelForModuleId(moduleId: string): string {
  const active = ACTIVE_RENDERER_MODULE_MANIFESTS.find((manifest) => manifest.id === moduleId)
  if (active) return active.displayName
  const comingSoon = COMING_SOON_MODULE_MANIFESTS.find((manifest) => manifest.id === moduleId)
  if (comingSoon) return comingSoon.displayName
  return moduleId
}

/**
 * Whether a workspace's mode can be rendered at all, and if not, why (MC-2577).
 *
 * Absence is a surface, never a blank (epic rule). Two ways a module-owned
 * workspace stops being renderable, and the copy differs because the remedy
 * does:
 *
 *  - `not-installed` — nothing registered this mode. A fresh machine, an
 *    uninstalled module, or a marketplace module whose install has not landed.
 *    The mode string is all there is to name it by.
 *  - `disabled` — the type IS registered and its owning module is switched off
 *    in Settings → Modules. This is where a persisted sprint workspace lands
 *    once the sprint mode is a registered type rather than a compiled-in enum:
 *    without this answer the layout mounts and every module-owned tab paints
 *    its own dead placeholder, which is the grid of blanks the rule exists to
 *    prevent. The module is on the machine, so the remedy is a toggle.
 *
 * `standard` is the shell's own mode and a bundled hidden host (the Automations
 * host) is a background container nobody opens, so neither can be absent.
 *
 * Pure and dependency-injected so the rule is asserted without a renderer host.
 */
export type WorkspaceModuleAbsence =
  | { kind: 'not-installed'; label: string }
  | { kind: 'disabled'; label: string; moduleId: string }
  | null

export function workspaceModuleAbsence(
  mode: string,
  deps: {
    isBundledHiddenMode: (mode: string) => boolean
    /** The module that registered this workspace type, or undefined when none did. */
    workspaceTypeModuleId: (mode: string) => string | undefined
    isModuleEnabled: (moduleId: string) => boolean
  },
): WorkspaceModuleAbsence {
  if (mode === 'standard') return null
  if (deps.isBundledHiddenMode(mode)) return null
  const moduleId = deps.workspaceTypeModuleId(mode)
  if (!moduleId) return { kind: 'not-installed', label: moduleLabelForMode(mode) }
  if (deps.isModuleEnabled(moduleId)) return null
  return { kind: 'disabled', label: moduleLabelForModuleId(moduleId), moduleId }
}

export function ModuleNotInstalledSurface({
  label,
  installed = false,
  actionLabel = 'Find it in Plugins',
  onOpenMarketplace,
}: {
  label: string
  /** True when the module is on the machine but disabled — the copy stays honest. */
  installed?: boolean
  /**
   * What the one action says. Defaults to the marketplace signpost; a caller
   * that routes somewhere else (a turned-off module goes to its settings, not
   * to a storefront that would offer to reinstall what is already there) names
   * that destination instead.
   */
  actionLabel?: string
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
            {actionLabel}
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
  moduleId,
  onOpenExtensions,
}: {
  label: string
  /** True when the module is on the machine but disabled — the copy stays honest. */
  installed?: boolean
  /**
   * The module this door belongs to (G9). When the marketplace registry carries
   * a module entry under this id, the door offers a real Install rather than
   * only a signpost to a catalogue the person then has to search.
   */
  moduleId?: string
  onOpenExtensions: () => void
}) {
  // Only a module that is genuinely absent can be installed; one that is on the
  // machine and switched off is a Settings toggle, and offering Install there
  // would be a button that reinstalls what is already there.
  const entry = useMarketplaceModuleEntry(installed ? undefined : moduleId)
  return (
    <div role="note" aria-label="Door module not installed" className="h-full">
      <EmptyState
        title={label}
        body={installed ? `The ${label} module is turned off.` : `The ${label} module isn’t installed.`}
        action={
          entry ? (
            <DoorModuleInstallControls entry={entry} onOpenExtensions={onOpenExtensions} />
          ) : (
            <PrimaryButton size="sm" onClick={onOpenExtensions}>
              Find it in Plugins
            </PrimaryButton>
          )
        }
      />
    </div>
  )
}

/**
 * The marketplace entry for a missing module id, or null.
 *
 * Read once per id. A registry that cannot be read leaves the door with the
 * signpost it always had — a door that cannot reach the marketplace must not
 * grow a button that fails when pressed.
 */
function useMarketplaceModuleEntry(moduleId: string | undefined): MarketplacePluginEntry | null {
  const [entry, setEntry] = useState<MarketplacePluginEntry | null>(null)
  useEffect(() => {
    setEntry(null)
    if (!moduleId) return
    if (typeof window.api?.readMarketplaceRegistry !== 'function') return
    let cancelled = false
    void window.api
      .readMarketplaceRegistry()
      .then((result) => {
        if (cancelled || !result.ok) return
        const match = marketplaceModuleEntry(moduleId, result.marketplace.plugins)
        if (match) setEntry(match)
      })
      .catch(() => {
        // Registry unreachable — the signpost already covers the door.
      })
    return () => {
      cancelled = true
    }
  }, [moduleId])
  return entry
}

/**
 * Install, from the door the module is missing from (G9).
 *
 * The same flow the storefront runs — verify, then install — through the same
 * `installFlow` view-model, so the two surfaces can never disagree about what a
 * classification means or what an install says afterwards. What this surface
 * deliberately does NOT carry is the trust prompt: disclosing the real
 * permissions of a community or unsigned bundle needs the panel that can show
 * them, so anything that would prompt is handed to Extensions → Plugins by
 * name rather than installed from here.
 *
 * "Find it in Plugins" stays, as the secondary action: it is the way to the
 * entry's detail, its source link, and everything this compact state cannot say.
 */
function DoorModuleInstallControls({
  entry,
  onOpenExtensions,
}: {
  entry: MarketplacePluginEntry
  onOpenExtensions: () => void
}) {
  const [flow, setFlow] = useState<InstallFlowState>({ status: 'idle' })

  const install = useCallback(async () => {
    if (typeof window.api?.verifyMarketplacePlugin !== 'function' || typeof window.api?.installMarketplacePluginFromRegistry !== 'function') {
      setFlow({ status: 'error', message: 'Installing extensions needs a newer app build. Update and restart.' })
      return
    }
    setFlow({ status: 'verifying' })
    let verify
    try {
      verify = await window.api.verifyMarketplacePlugin(entry)
    } catch (error) {
      setFlow({ status: 'error', message: error instanceof Error ? error.message : 'Could not verify this extension.' })
      return
    }
    const outcome = classifyVerification(verify, entry.provides)
    if (outcome.kind === 'blocked') {
      setFlow({ status: 'blocked', classification: outcome.classification, message: outcome.message, issues: outcome.issues })
      return
    }
    if (outcome.kind === 'needs-trust') {
      setFlow({
        status: 'error',
        message: `${entry.name} asks you to trust it before it installs. Open it in Plugins, where you can read what it wants first.`,
      })
      return
    }
    setFlow({ status: 'installing' })
    try {
      // No workspace: a module installs into the user module root, and this
      // door may be open with no project at all.
      const { installAndActivateRendererModules } = await import('../../modules')
      const result = await installAndActivateRendererModules(() => window.api.installMarketplacePluginFromRegistry({ entry }))
      setFlow(summarizeInstallResult(result))
    } catch (error) {
      setFlow({
        status: 'error',
        message: error instanceof Error ? error.message : 'The install could not be completed.',
      })
    }
  }, [entry])

  const view = deriveInstallView(flow)
  return (
    <div className="flex flex-col items-center gap-2">
      {view.notice ? (
        view.notice.tone === 'good' ? (
          <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]" role="status">
            <StatusDot tone="good" />
            <span>{view.notice.message}</span>
          </div>
        ) : (
          <InlineNotice tone={view.notice.tone}>{view.notice.message}</InlineNotice>
        )
      ) : null}
      {view.busy ? (
        <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]" role="status">
          <Spinner size={14} />
          {view.busyLabel}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {view.action ? (
          <PrimaryButton size="sm" onClick={() => void install()}>
            {view.action.kind === 'retry' ? view.action.label : `Install ${entry.name}`}
          </PrimaryButton>
        ) : null}
        <GhostButton size="sm" onClick={onOpenExtensions}>
          Find it in Plugins
        </GhostButton>
      </div>
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

/**
 * The registry entry that would install this module id, or null.
 *
 * The `provides` check is the whole rule and is not a formality: an entry may
 * share an id with a module and ship only skills, and installing that would put
 * something on the machine that cannot open the door the person is standing at.
 * Pure, so the rule is asserted without a registry or a renderer.
 */
export function marketplaceModuleEntry<T extends Pick<MarketplacePluginEntry, 'id' | 'provides'>>(
  moduleId: string,
  plugins: readonly T[],
): T | null {
  const id = moduleId.trim()
  if (!id) return null
  return plugins.find((plugin) => plugin.id === id && plugin.provides.includes('module')) ?? null
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
