// Part of the IPC contract: reading the marketplace registry and its update states.
// ../electron-api.ts re-exports everything here.

import type { MarketplaceIndex, MarketplaceManifestIssue } from '../marketplace/manifest'
import type { MarketplaceUpdateStateEntry } from '../marketplace/update-state'
import type { MarketplaceRegistryState } from './marketplace'

export type MarketplaceRegistryReadInput = {
  forceRefresh?: boolean
}

export type MarketplaceRegistryReadResult =
  | {
      ok: true
      state: 'ok' | 'empty'
      registryUrl: string
      source: 'network' | 'cache' | 'bundled'
      stale: false
      fetchedAt: string
      etag?: string
      notModified?: boolean
      marketplace: MarketplaceIndex
    }
  | {
      ok: true
      state: 'offline'
      registryUrl: string
      source: 'cache' | 'seed'
      stale: boolean
      fetchedAt: string
      etag?: string
      marketplace: MarketplaceIndex
      message: string
    }
  | {
      ok: false
      state: Exclude<MarketplaceRegistryState, 'ok' | 'empty'>
      registryUrl: string
      stale: false
      message: string
      statusCode?: number
      issues?: MarketplaceManifestIssue[]
    }

// Per-installed-entry update detection. `checked: false` is the
// honest "couldn't check for updates" shape — the registry read failed, so
// every entry carries `state: 'unknown'`, never "up to date". The `ok: false`
// arm is a local failure (unreadable receipt store), not a registry one.
export type MarketplaceUpdateStatesResult =
  | {
      ok: true
      checked: true
      registryState: MarketplaceRegistryState
      registrySource: 'network' | 'cache' | 'bundled' | 'seed'
      stale: boolean
      fetchedAt: string
      registryMessage?: string
      entries: MarketplaceUpdateStateEntry[]
    }
  | {
      ok: true
      checked: false
      registryState: MarketplaceRegistryState
      registryMessage?: string
      entries: MarketplaceUpdateStateEntry[]
    }
  | { ok: false; message: string }
