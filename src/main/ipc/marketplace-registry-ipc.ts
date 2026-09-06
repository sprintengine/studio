import { app, type IpcMain } from 'electron'

import type { MarketplaceRegistryReadInput, MarketplaceRegistryReadResult } from '../../shared/electron-api'
import {
  MarketplaceRegistryClient,
  configuredMarketplaceRegistryUrl,
  defaultMarketplaceRegistryCachePath,
} from '../marketplace/registry-client'

export type MarketplaceRegistryReader = {
  read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
}

export type MarketplaceRegistryIpcHandlers = {
  read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
}

export function createMarketplaceRegistryIpcHandlers(
  reader: MarketplaceRegistryReader = createDefaultMarketplaceRegistryClient()
): MarketplaceRegistryIpcHandlers {
  return {
    read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult> {
      return reader.read(input)
    },
  }
}

export function registerMarketplaceRegistryIpc(
  ipcMain: IpcMain,
  overrides: Partial<MarketplaceRegistryIpcHandlers> = {}
): void {
  const handlers: MarketplaceRegistryIpcHandlers = {
    read: overrides.read ?? createMarketplaceRegistryIpcHandlers().read,
  }

  ipcMain.handle(
    'marketplace:registry:read',
    async (_event, input?: unknown): Promise<MarketplaceRegistryReadResult> => {
      const readInput = validateReadInput(input)
      if (!readInput.ok) return readInput.result

      try {
        return await handlers.read(readInput.input)
      } catch (error) {
        return {
          ok: false,
          state: 'fetch-error',
          registryUrl: configuredMarketplaceRegistryUrl(),
          stale: false,
          message: formatError(error),
        }
      }
    }
  )
}

// Also the registry reader the update-state detection uses
// (marketplace-plugin-ipc), so both surfaces share one cache and one
// bundled-first/override policy.
export function createDefaultMarketplaceRegistryClient(): MarketplaceRegistryClient {
  return new MarketplaceRegistryClient({
    registryUrl: configuredMarketplaceRegistryUrl(),
    cachePath: defaultMarketplaceRegistryCachePath(app.getPath('userData')),
    // Remote first, the model feed's rule (backlog/2026-09-05-plugin-sources.md,
    // "Hosting"): the index lives in the public releases repo and is edited
    // there by pull request, so a fetch with ETag is how an added or updated
    // plugin reaches every machine without an app release. The committed seed
    // is the offline and first-boot fallback, never the preferred read.
    preferBundledSeed: false,
  })
}

function validateReadInput(input: unknown): { ok: true; input?: MarketplaceRegistryReadInput } | { ok: false; result: MarketplaceRegistryReadResult } {
  if (input === undefined) return { ok: true }
  if (!isObject(input)) return invalidReadInputResult()
  if ('forceRefresh' in input && typeof input.forceRefresh !== 'boolean') return invalidReadInputResult()
  return { ok: true, input: { ...(typeof input.forceRefresh === 'boolean' ? { forceRefresh: input.forceRefresh } : {}) } }
}

function invalidReadInputResult(): { ok: false; result: MarketplaceRegistryReadResult } {
  return {
    ok: false,
    result: {
      ok: false,
      state: 'fetch-error',
      registryUrl: configuredMarketplaceRegistryUrl(),
      stale: false,
      message: 'Invalid marketplace registry read input.',
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
