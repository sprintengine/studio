import { rm } from 'node:fs/promises'

import type { MarketplaceManifestIssue, MarketplacePluginEntry } from '../../shared/marketplace'
import { validateMarketplaceIndex } from '../../shared/marketplace'
import type { MarketplacePluginVerifyResult } from '../../shared/electron-api'
import type { CapabilityPermission } from '../../shared/modules/permissions'
import type { ModuleTrustContext } from '../modules/module-signature'
import {
  defaultMarketplacePluginStagingRoot,
  downloadMarketplacePluginBundle,
  type MarketplacePluginDownloadFetch,
} from './plugin-download'

export type MarketplacePluginVerifierServices = {
  trustContext: () => ModuleTrustContext
  stagingRoot?: string
  fetcher?: MarketplacePluginDownloadFetch
}

export function createMarketplacePluginVerifier(services: MarketplacePluginVerifierServices) {
  return {
    verify: (entry: MarketplacePluginEntry): Promise<MarketplacePluginVerifyResult> =>
      verifyMarketplacePlugin(entry, services),
  }
}

export async function verifyMarketplacePlugin(
  entry: MarketplacePluginEntry,
  services: MarketplacePluginVerifierServices
): Promise<MarketplacePluginVerifyResult> {
  const registryEntry = validateRegistryEntry(entry)
  if (!registryEntry.ok) {
    return {
      classification: 'invalid',
      permissions: [],
      sourceUrl: sourceUrlFromEntry(entry),
      issues: registryEntry.issues,
      message: registryEntry.message,
    }
  }

  const download = await downloadMarketplacePluginBundle({
    entry: registryEntry.entry,
    trustContext: services.trustContext(),
    stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(),
    fetcher: services.fetcher,
  })

  if (!download.ok) {
    return {
      classification: download.classification ?? 'invalid',
      permissions: [],
      sourceUrl: download.sourceUrl,
      issues: download.issues ?? [{ path: 'source', message: download.message }],
      message: download.message,
    }
  }

  try {
    return {
      classification: download.classification,
      permissions: [...((download.manifest.permissions ?? []) as CapabilityPermission[])],
      sourceUrl: download.sourceUrl,
    }
  } finally {
    await rm(download.stagedBundlePath, { recursive: true, force: true })
  }
}

function validateRegistryEntry(
  entry: MarketplacePluginEntry
): { ok: true; entry: MarketplacePluginEntry } | { ok: false; message: string; issues: MarketplaceManifestIssue[] } {
  const result = validateMarketplaceIndex({ schemaVersion: 1, plugins: [entry] })
  if (!result.ok) {
    return {
      ok: false,
      message: 'Marketplace plugin registry entry is invalid.',
      issues: result.issues,
    }
  }
  const validated = result.marketplace.plugins[0]
  if (!validated) {
    return {
      ok: false,
      message: 'Marketplace plugin registry entry is invalid.',
      issues: [{ path: 'entry', message: 'entry is required.' }],
    }
  }
  return { ok: true, entry: validated }
}

function sourceUrlFromEntry(entry: MarketplacePluginEntry): string {
  return typeof entry?.source === 'string' ? entry.source.trim() : ''
}
