// Per-installed-entry update detection (MC-1873): compares what is installed
// (install receipts + directly installed user modules) against the registry's
// `latest`, through the pure shared detector. Honest failure is part of the
// contract — a registry that cannot be read yields `unknown` on every entry,
// never "up to date".

import type {
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
} from '../../shared/electron-api'
import { marketplaceUpdateAvailability, type MarketplaceUpdateStateEntry } from '../../shared/marketplace'
import type { ModuleTrustContext } from '../modules/module-signature'
import { discoverUserModules } from '../modules/user-module-registry'
import { readMarketplacePluginInstallReceipts } from './plugin-lifecycle'

export type MarketplaceUpdateStatesServices = {
  registryReader: { read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult> }
  receiptStorePath: string
  moduleRoot: () => string
  trustContext: () => ModuleTrustContext
}

type InstalledEntry = { id: string; displayName: string; installedVersion: number }

export async function readMarketplaceUpdateStates(
  services: MarketplaceUpdateStatesServices,
  input: MarketplaceRegistryReadInput = {},
): Promise<MarketplaceUpdateStatesResult> {
  const receiptsRead = await readMarketplacePluginInstallReceipts(services.receiptStorePath)
  if (!receiptsRead.ok) return { ok: false, message: receiptsRead.message }

  // Receipts are the authoritative installed set for marketplace installs;
  // their version is pinned to the registry `latest` that was installed.
  const installed: InstalledEntry[] = []
  const claimedIds = new Set<string>()
  // Module folders a receipt owns (its `module` components): their lifecycle
  // is the receipt's, so they must not surface as a second entry under the
  // component's own id.
  const receiptOwnedModuleIds = new Set<string>()
  for (const receipt of receiptsRead.receipts) {
    installed.push({ id: receipt.id, displayName: receipt.displayName, installedVersion: receipt.version })
    claimedIds.add(receipt.id)
    for (const component of receipt.components) {
      if (component.kind === 'module') receiptOwnedModuleIds.add(component.id)
    }
  }

  // Directly installed user modules (folder installs, local dev builds) have
  // no receipt; their on-disk manifest version is the installed version. This
  // is the population where `ahead-of-registry` actually occurs. Deliberately
  // not gated on trust or enablement — a disabled or unapproved module still
  // has an honest update state.
  const discovered = await discoverUserModules(services.moduleRoot(), services.trustContext())
  for (const module of discovered.modules) {
    const id = module.manifest.id
    if (claimedIds.has(id) || receiptOwnedModuleIds.has(id)) continue
    claimedIds.add(id)
    installed.push({ id, displayName: module.manifest.displayName, installedVersion: module.manifest.version })
  }

  const registry = await services.registryReader.read(input)
  if (!registry.ok) {
    // Couldn't check: every installed entry reads unknown, asserted distinct
    // from `current` by the shared availability type.
    return {
      ok: true,
      checked: false,
      registryState: registry.state,
      ...(registry.message ? { registryMessage: registry.message } : {}),
      entries: installed.map((entry): MarketplaceUpdateStateEntry => ({
        id: entry.id,
        displayName: entry.displayName,
        availability: { state: 'unknown', installedVersion: entry.installedVersion, reason: 'registry-unreachable' },
      })),
    }
  }

  const latestById = new Map(registry.marketplace.plugins.map((plugin) => [plugin.id, plugin.latest]))
  const registryMessage = registry.state === 'offline' ? registry.message : undefined
  return {
    ok: true,
    checked: true,
    registryState: registry.state,
    registrySource: registry.source,
    stale: registry.stale,
    fetchedAt: registry.fetchedAt,
    ...(registryMessage ? { registryMessage } : {}),
    entries: installed.map((entry): MarketplaceUpdateStateEntry => ({
      id: entry.id,
      displayName: entry.displayName,
      availability: marketplaceUpdateAvailability(entry.installedVersion, latestById.get(entry.id)),
    })),
  }
}
