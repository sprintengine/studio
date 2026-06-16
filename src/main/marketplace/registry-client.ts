import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
} from '../../shared/electron-api'
import {
  parseMarketplaceIndex,
  validateMarketplaceIndex,
  type MarketplaceIndex,
} from '../../shared/marketplace'

export const DEFAULT_MARKETPLACE_REGISTRY_URL =
  'https://raw.githubusercontent.com/multicode-labs/marketplace/main/marketplace.json'
export const MARKETPLACE_REGISTRY_CACHE_FILENAME = 'marketplace-registry-cache.json'
export const DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS = 15_000

export type MarketplaceRegistryFetch = (url: string, init: RequestInit) => Promise<Response>

export type MarketplaceRegistryClientOptions = {
  registryUrl?: string
  cachePath: string
  fetcher?: MarketplaceRegistryFetch
  timeoutMs?: number
  now?: () => Date
}

type RegistryCacheFile = {
  schemaVersion: 1
  registryUrl: string
  etag?: string
  fetchedAt: string
  marketplace: MarketplaceIndex
}

export function defaultMarketplaceRegistryCachePath(userDataDir: string): string {
  return join(userDataDir, MARKETPLACE_REGISTRY_CACHE_FILENAME)
}

export class MarketplaceRegistryClient {
  private readonly registryUrl: string
  private readonly cachePath: string
  private readonly fetcher: MarketplaceRegistryFetch
  private readonly timeoutMs: number
  private readonly now: () => Date

  constructor(options: MarketplaceRegistryClientOptions) {
    this.registryUrl = options.registryUrl ?? DEFAULT_MARKETPLACE_REGISTRY_URL
    this.cachePath = options.cachePath
    this.fetcher = options.fetcher ?? defaultFetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS
    this.now = options.now ?? (() => new Date())
  }

  async read(input: MarketplaceRegistryReadInput = {}): Promise<MarketplaceRegistryReadResult> {
    const registryUrl = this.registryUrl.trim()
    const parsedUrl = parseHttpsUrl(registryUrl)
    if (!parsedUrl.ok) {
      return {
        ok: false,
        state: 'fetch-error',
        registryUrl,
        stale: false,
        message: parsedUrl.message,
      }
    }

    const cache = await this.readCache(registryUrl)
    let response: Response
    try {
      response = await this.fetchWithTimeout(parsedUrl.url, cache, input.forceRefresh === true)
    } catch (error) {
      return this.staleOrFailure('offline', registryUrl, cache, `Marketplace registry is offline. ${formatError(error)}`)
    }

    if (response.status === 304) {
      if (!cache) {
        return {
          ok: false,
          state: 'fetch-error',
          registryUrl,
          stale: false,
          statusCode: response.status,
          message: 'Marketplace registry returned 304 Not Modified, but no usable cache exists.',
        }
      }
      return registrySuccess(registryUrl, cache.marketplace, {
        source: 'cache',
        stale: false,
        fetchedAt: cache.fetchedAt,
        etag: cache.etag,
        notModified: true,
      })
    }

    if (!response.ok) {
      const message = `Marketplace registry fetch failed with HTTP ${response.status}.`
      if (isTransientStatus(response.status)) {
        return this.staleOrFailure('fetch-error', registryUrl, cache, message, response.status)
      }
      return {
        ok: false,
        state: 'fetch-error',
        registryUrl,
        stale: false,
        statusCode: response.status,
        message,
      }
    }

    let source: string
    try {
      source = await response.text()
    } catch (error) {
      return this.staleOrFailure('offline', registryUrl, cache, `Marketplace registry response could not be read. ${formatError(error)}`)
    }

    const parsed = parseMarketplaceIndex(source)
    if (!parsed.ok) {
      return {
        ok: false,
        state: 'invalid-schema',
        registryUrl,
        stale: false,
        issues: parsed.issues,
        message: 'Marketplace registry returned invalid marketplace.json.',
      }
    }

    const etag = response.headers.get('etag') ?? cache?.etag
    const fetchedAt = this.now().toISOString()
    await this.writeCache({
      schemaVersion: 1,
      registryUrl,
      ...(etag ? { etag } : {}),
      fetchedAt,
      marketplace: parsed.marketplace,
    })

    return registrySuccess(registryUrl, parsed.marketplace, {
      source: 'network',
      stale: false,
      fetchedAt,
      etag,
    })
  }

  private async fetchWithTimeout(url: URL, cache: RegistryCacheFile | null, forceRefresh: boolean): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (!forceRefresh && cache?.etag) headers['if-none-match'] = cache.etag

    return this.fetcher(url.toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
  }

  private async readCache(registryUrl: string): Promise<RegistryCacheFile | null> {
    try {
      const payload = JSON.parse(await readFile(this.cachePath, 'utf8')) as Partial<RegistryCacheFile>
      if (payload.schemaVersion !== 1) return null
      if (payload.registryUrl !== registryUrl) return null
      if (typeof payload.fetchedAt !== 'string') return null
      const result = validateMarketplaceIndex(payload.marketplace)
      if (!result.ok) return null
      return {
        schemaVersion: 1,
        registryUrl,
        ...(typeof payload.etag === 'string' && payload.etag.length > 0 ? { etag: payload.etag } : {}),
        fetchedAt: payload.fetchedAt,
        marketplace: result.marketplace,
      }
    } catch {
      return null
    }
  }

  private async writeCache(cache: RegistryCacheFile): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeFile(this.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  }

  private staleOrFailure(
    failureState: 'offline' | 'fetch-error',
    registryUrl: string,
    cache: RegistryCacheFile | null,
    message: string,
    statusCode?: number
  ): MarketplaceRegistryReadResult {
    if (cache) {
      return {
        ok: true,
        state: 'offline',
        registryUrl,
        source: 'cache',
        stale: true,
        fetchedAt: cache.fetchedAt,
        ...(cache.etag ? { etag: cache.etag } : {}),
        marketplace: cache.marketplace,
        message,
      }
    }
    return {
      ok: false,
      state: failureState,
      registryUrl,
      stale: false,
      ...(statusCode ? { statusCode } : {}),
      message,
    }
  }
}

function registrySuccess(
  registryUrl: string,
  marketplace: MarketplaceIndex,
  meta: {
    source: 'network' | 'cache'
    stale: false
    fetchedAt: string
    etag?: string
    notModified?: boolean
  }
): MarketplaceRegistryReadResult {
  return {
    ok: true,
    state: marketplace.plugins.length > 0 ? 'ok' : 'empty',
    registryUrl,
    source: meta.source,
    stale: false,
    fetchedAt: meta.fetchedAt,
    ...(meta.etag ? { etag: meta.etag } : {}),
    ...(meta.notModified ? { notModified: true } : {}),
    marketplace,
  }
}

function parseHttpsUrl(value: string): { ok: true; url: URL } | { ok: false; message: string } {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') {
      return { ok: false, message: 'Marketplace registry URL must use HTTPS.' }
    }
    return { ok: true, url }
  } catch {
    return { ok: false, message: 'Marketplace registry URL is invalid.' }
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('fetch is not available in this runtime.')
  }
  return globalThis.fetch(url, init)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
