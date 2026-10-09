// Settings → Extensions, the derivations. DOM-free so every rule the page
// draws by — which state word a row wears, when the restart banner shows,
// where Update is offered, what a filter keeps — is asserted without
// rendering anything.

import type { MarketplaceUpdateStatesResult } from '../../../../shared/electron-api'
import { HOST_API_MIN_SUPPORTED, HOST_API_VERSION } from '../../../../shared/modules/host-api'
import type {
  CapabilityManifest,
  ModuleEnablementOverrides,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import { capabilityAccess, partitionCapabilityAccess } from '../../../../shared/modules/permissions'
import type { ThirdPartyRendererLoadState } from '../../modules/third-party-loader'
import type { AccessItem } from '../ui'

// ── State ────────────────────────────────────────────────────────────────

/**
 * What a trusted module is doing, in the words its row says:
 * - `running` — its code is loaded in this session (Running);
 * - `on` — on, with no code of its own to run (On);
 * - `pending` — on, but its main entry waits on the next launch (Starts after restart);
 * - `stopping` — turned off, but its main entry stays loaded until the next launch (Stops after restart);
 * - `off` — off (Off);
 * - `failed` — it could not start (Couldn't start), with the reason as a notice.
 */
export type ExtensionRunState = 'running' | 'on' | 'pending' | 'stopping' | 'off' | 'failed'

export const RUN_STATE_LABEL: Record<ExtensionRunState, string> = {
  running: 'Running',
  on: 'On',
  pending: 'Starts after restart',
  stopping: 'Stops after restart',
  off: 'Off',
  failed: 'Couldn’t start',
}

export type ExtensionProblem =
  // Built for a host API this app does not provide. `direction` says which way.
  | { kind: 'host-api'; direction: 'older' | 'newer' | 'unknown' }
  // A tampered or invalid signature: it can never be trusted as installed.
  | { kind: 'invalid' }
  // It was loaded and failed, this session.
  | { kind: 'error'; message: string }

export function hostApiDirection(manifest: Pick<CapabilityManifest, 'engines'>): 'older' | 'newer' | 'unknown' {
  const hostApi = manifest.engines?.hostApi
  if (typeof hostApi !== 'number' || !Number.isInteger(hostApi)) return 'unknown'
  if (hostApi > HOST_API_VERSION) return 'newer'
  if (hostApi < HOST_API_MIN_SUPPORTED) return 'older'
  return 'unknown'
}

/** Why a module cannot run as installed, whatever its trust, or null. */
export function moduleProblem(
  module: ThirdPartyModuleView,
  rendererLoadState: ThirdPartyRendererLoadState | undefined,
  contributionError?: string,
): ExtensionProblem | null {
  if (module.trust === 'invalid' || module.launch.status === 'blocked_invalid') return { kind: 'invalid' }
  if (module.launch.status === 'blocked_host_api') {
    return { kind: 'host-api', direction: hostApiDirection(module.manifest) }
  }
  if (module.trust !== 'trusted') return null
  if (module.launch.status === 'launch_error') {
    return { kind: 'error', message: module.launch.message ?? 'Its main entry failed at the last launch.' }
  }
  const renderer = module.launch.rendererEntry
  if (renderer?.availability === 'error') {
    return { kind: 'error', message: renderer.message ?? 'Its window code could not be read.' }
  }
  if (rendererLoadState?.status === 'error') return { kind: 'error', message: rendererLoadState.message }
  if (contributionError) return { kind: 'error', message: contributionError }
  return null
}

export function problemText(problem: ExtensionProblem): string {
  switch (problem.kind) {
    case 'host-api':
      return problem.direction === 'older'
        ? 'Built for an older version of Studio.'
        : problem.direction === 'newer'
          ? 'Built for a newer version of Studio.'
          : 'Doesn’t say which version of Studio it’s built for.'
    case 'invalid':
      return 'Its signature doesn’t match its files, so it can’t be trusted.'
    case 'error':
      return problem.message
  }
}

const hasRendererEntry = (module: ThirdPartyModuleView): boolean =>
  Boolean(module.launch.rendererEntry && module.launch.rendererEntry.availability !== 'none')

/**
 * The state word for a TRUSTED module. Main code loads once, at launch, so a
 * main entry turned on since reads "Starts after restart" and one turned off
 * reads "Stops after restart" until the next launch; renderer contributions
 * follow the switch live.
 */
export function runState(
  module: ThirdPartyModuleView,
  enabled: boolean,
  rendererLoadState: ThirdPartyRendererLoadState | undefined,
  contributionError?: string,
): ExtensionRunState {
  if (moduleProblem(module, rendererLoadState, contributionError)) return 'failed'
  const mainLoaded = module.launch.mainLoaded === true
  if (!enabled) return module.launch.hasMainEntry && mainLoaded ? 'stopping' : 'off'
  if (module.launch.hasMainEntry) return mainLoaded ? 'running' : 'pending'
  if (hasRendererEntry(module)) return rendererLoadState?.status === 'loaded' ? 'running' : 'pending'
  return 'on'
}

/** The live enablement intent: an explicit override, else the manifest default. */
export function resolveModuleEnabled(overrides: ModuleEnablementOverrides, module: ThirdPartyModuleView): boolean {
  return overrides[module.manifest.id] ?? module.manifest.defaultEnabled
}

// ── Restart ──────────────────────────────────────────────────────────────

/**
 * Trusted, enabled modules whose main entry is ready but was not loaded this
 * session. A module that failed or cannot run on this host is not waiting on a
 * restart, and says so on its own row.
 */
export function modulesAwaitingRestart(
  modules: readonly ThirdPartyModuleView[],
  enabledFor: (module: ThirdPartyModuleView) => boolean,
): ThirdPartyModuleView[] {
  return modules.filter(
    (module) =>
      module.trust === 'trusted' &&
      module.launch.status === 'trusted_executable' &&
      module.launch.hasMainEntry &&
      module.launch.mainLoaded !== true &&
      enabledFor(module),
  )
}

export function restartBannerTitle(waiting: readonly Pick<ThirdPartyModuleView, 'manifest'>[]): string | null {
  if (waiting.length === 0) return null
  return waiting.length === 1
    ? `Restart Studio to start ${waiting[0]!.manifest.displayName}`
    : `Restart Studio to start ${waiting.length} extensions`
}

// ── Identity ─────────────────────────────────────────────────────────────

export function sourceLabel(module: Pick<ThirdPartyModuleView, 'origin'>): string | null {
  switch (module.origin?.kind) {
    case 'marketplace':
      return 'Marketplace'
    case 'github':
      return 'GitHub'
    case 'folder':
      return 'Local build'
    default:
      return null
  }
}

/** Whether the installed manifest carries a signature that checked out. */
export function isSigned(module: Pick<ThirdPartyModuleView, 'trust' | 'manifest'>): boolean {
  if (module.trust === 'signed') return true
  if (module.trust === 'trusted') return Boolean(module.manifest.signature)
  return false
}

export function signatureLabel(module: Pick<ThirdPartyModuleView, 'trust' | 'manifest'>): string {
  if (module.trust === 'invalid') return 'Invalid signature'
  return isSigned(module) ? 'Signed' : 'Unsigned'
}

// The publisher the SDK's scaffold writes into every new module. It names no
// one, so a row that printed it would be reading out a placeholder.
const SCAFFOLD_PUBLISHER = 'Local developer'

/** Who published it, when the manifest names someone. */
export function publisherName(manifest: Pick<CapabilityManifest, 'publisher'>): string | null {
  const publisher = manifest.publisher?.trim()
  return publisher && publisher !== SCAFFOLD_PUBLISHER ? publisher : null
}

/** "acme · GitHub · Signed" — publisher, source and signature, each when known. */
export function moduleMeta(module: ThirdPartyModuleView): string {
  return [publisherName(module.manifest), sourceLabel(module), signatureLabel(module)].filter(Boolean).join(' · ')
}

// ── Access ───────────────────────────────────────────────────────────────

export function accessItems(permissions: readonly string[] | undefined): {
  care: AccessItem[]
  standard: AccessItem[]
} {
  const { care, standard } = partitionCapabilityAccess(permissions ?? [])
  const item = (id: string): AccessItem => {
    const access = capabilityAccess(id)
    return { id, title: access.title, ...(access.why ? { why: access.why } : {}) }
  }
  return { care: care.map(item), standard: standard.map(item) }
}

// ── Update ───────────────────────────────────────────────────────────────

export type ExtensionUpdate = { pluginId: string; latestVersion: number }

/**
 * An update Studio can actually install: the module came from the marketplace
 * and the registry lists a newer version of the bundle it came in. A GitHub or
 * folder install, or a registry that could not be read, offers nothing.
 */
export function marketplaceUpdateFor(
  module: Pick<ThirdPartyModuleView, 'origin'>,
  states: MarketplaceUpdateStatesResult | null,
): ExtensionUpdate | null {
  if (module.origin?.kind !== 'marketplace' || !states?.ok || !states.checked) return null
  const pluginId = module.origin.pluginId
  const entry = states.entries.find((candidate) => candidate.id === pluginId)
  if (!entry || entry.availability.state !== 'update-available') return null
  return { pluginId, latestVersion: entry.availability.latestVersion }
}

// ── Filter ───────────────────────────────────────────────────────────────

export type ExtensionFilter = 'all' | 'review' | 'on' | 'off'

export const needsReview = (module: ThirdPartyModuleView): boolean => module.trust !== 'trusted'

export function matchesQuery(query: string, ...parts: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return parts.some((part) => part?.toLowerCase().includes(needle))
}

export function moduleMatchesQuery(module: ThirdPartyModuleView, query: string): boolean {
  return matchesQuery(
    query,
    module.manifest.displayName,
    module.manifest.summary,
    module.manifest.publisher,
    module.manifest.id,
  )
}

/** Whether a third-party module belongs under the filter. */
export function moduleMatchesFilter(module: ThirdPartyModuleView, filter: ExtensionFilter, enabled: boolean): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'review':
      return needsReview(module)
    case 'on':
      return !needsReview(module) && enabled
    case 'off':
      return !needsReview(module) && !enabled
  }
}

/** Whether a built-in module belongs under the filter; built-ins never need review. */
export function builtInMatchesFilter(filter: ExtensionFilter, enabled: boolean): boolean {
  if (filter === 'review') return false
  if (filter === 'on') return enabled
  if (filter === 'off') return !enabled
  return true
}
