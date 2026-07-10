import { app, type IpcMain } from 'electron'

import type { MarketplaceRegistryReadInput, MarketplaceRegistryReadResult } from '../../shared/electron-api'
import {
  MarketplaceRegistryClient,
  configuredMarketplaceRegistryUrl,
  defaultMarketplaceRegistryCachePath,
  isMarketplaceRegistryOverrideConfigured,
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

function createDefaultMarketplaceRegistryClient(): MarketplaceRegistryClient {
  return new MarketplaceRegistryClient({
    registryUrl: configuredMarketplaceRegistryUrl(),
    cachePath: defaultMarketplaceRegistryCachePath(app.getPath('userData')),
    // No override -> the committed snapshot-generated seed is the registry;
    // the env override keeps the full remote fetch/ETag/cache path.
    preferBundledSeed: !isMarketplaceRegistryOverrideConfigured(),
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
