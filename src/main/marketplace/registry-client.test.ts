import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MarketplaceRegistryReadResult } from '../../shared/electron-api'
import type { MarketplaceIndex } from '../../shared/marketplace'
import { registerMarketplaceRegistryIpc } from '../ipc/marketplace-registry-ipc'
import {
  MarketplaceRegistryClient,
  type MarketplaceRegistryFetch,
} from './registry-client'

const REGISTRY_URL = 'https://example.com/marketplace.json'
const VALID_SIGNATURE = { algorithm: 'ed25519' as const, publicKey: 'YWJj', signature: 'ZGVm' }

type Handler = (event: unknown, ...args: unknown[]) => unknown
type FetchRequest = { url: string; init: RequestInit }

async function main(): Promise<void> {
  await testFetchesValidRegistryAndCachesEtag()
  await testEtagNotModifiedServesCache()
  await testFreshResponseWithoutEtagClearsCachedEtag()
  await testEmptyRegistryStateIsExplicit()
  await testOfflineWithCacheServesStaleState()
  await testOfflineWithoutCacheIsExplicitFailure()
  await testFetchErrorIsDistinct()
  await testInvalidSchemaDoesNotSilentlyUseCache()
  await testRejectsNonHttpsRegistryUrl()
  await testRegistryIpcChannel()

  console.log('marketplace registry client tests passed')
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-marketplace-registry-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function validMarketplace(plugins: MarketplaceIndex['plugins'] = [validPlugin()]): MarketplaceIndex {
  return { schemaVersion: 1, plugins }
}

function validPlugin(): MarketplaceIndex['plugins'][number] {
  return {
    id: 'dev-helper',
    name: 'Dev Helper',
    publisher: { name: 'Multicode Labs', verified: true },
    summary: 'Adds development helpers.',
    category: 'dev-tools',
    icon: 'icons/dev-helper.svg',
    latest: 1,
    source: 'https://github.com/multicode-labs/marketplace/plugins/dev-helper',
    provides: ['mcp', 'skills'],
    signature: VALID_SIGNATURE,
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
}

function notModifiedResponse(etag: string): Response {
  return new Response(null, { status: 304, headers: { etag } })
}

function requestHeaders(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>
}

async function testFetchesValidRegistryAndCachesEtag(): Promise<void> {
  await withTempDir(async (dir) => {
    const requests: FetchRequest[] = []
    const fetcher: MarketplaceRegistryFetch = async (url, init) => {
      requests.push({ url, init })
      return jsonResponse(validMarketplace(), { headers: { etag: '"v1"' } })
    }
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath: join(dir, 'cache.json'),
      fetcher,
      now: () => new Date('2026-06-16T00:00:00.000Z'),
    })

    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.state, 'ok')
    assert.equal(result.source, 'network')
    assert.equal(result.registryUrl, REGISTRY_URL)
    assert.equal(result.etag, '"v1"')
    assert.equal(result.fetchedAt, '2026-06-16T00:00:00.000Z')
    assert.equal(requests[0].url, REGISTRY_URL)
    assert.equal(requestHeaders(requests[0].init)['if-none-match'], undefined)

    const cache = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8')) as { etag?: string }
    assert.equal(cache.etag, '"v1"')
  })
}

async function testEtagNotModifiedServesCache(): Promise<void> {
  await withTempDir(async (dir) => {
    const requests: FetchRequest[] = []
    const responses = [
      jsonResponse(validMarketplace(), { headers: { etag: '"v1"' } }),
      notModifiedResponse('"v1"'),
    ]
    const fetcher: MarketplaceRegistryFetch = async (url, init) => {
      requests.push({ url, init })
      const response = responses.shift()
      assert.ok(response, 'test fetcher exhausted')
      return response
    }
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath: join(dir, 'cache.json'),
      fetcher,
      now: () => new Date('2026-06-16T00:00:00.000Z'),
    })

    await client.read()
    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.state, 'ok')
    assert.equal(result.source, 'cache')
    assert.equal(result.notModified, true)
    assert.equal(result.etag, '"v1"')
    assert.equal(requestHeaders(requests[1].init)['if-none-match'], '"v1"')
  })
}

async function testFreshResponseWithoutEtagClearsCachedEtag(): Promise<void> {
  await withTempDir(async (dir) => {
    const requests: FetchRequest[] = []
    const v1 = validMarketplace()
    const v2 = validMarketplace([
      {
        ...validPlugin(),
        id: 'second-helper',
        name: 'Second Helper',
        source: 'https://github.com/multicode-labs/marketplace/plugins/second-helper',
      },
    ])
    const responses = [
      jsonResponse(v1, { headers: { etag: '"v1"' } }),
      jsonResponse(v2),
      jsonResponse(v2),
    ]
    const fetcher: MarketplaceRegistryFetch = async (url, init) => {
      requests.push({ url, init })
      const response = responses.shift()
      assert.ok(response, 'test fetcher exhausted')
      return response
    }
    const cachePath = join(dir, 'cache.json')
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath,
      fetcher,
    })

    await client.read()
    const noEtag = await client.read({ forceRefresh: true })

    assert.equal(noEtag.ok, true)
    if (!noEtag.ok) return
    assert.equal(noEtag.etag, undefined)
    assert.equal(noEtag.marketplace.plugins[0].id, 'second-helper')

    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
      etag?: string
      marketplace?: MarketplaceIndex
    }
    assert.equal(cache.etag, undefined)
    assert.equal(cache.marketplace?.plugins[0]?.id, 'second-helper')

    await client.read()

    assert.equal(requestHeaders(requests[2].init)['if-none-match'], undefined)
  })
}

async function testEmptyRegistryStateIsExplicit(): Promise<void> {
  await withTempDir(async (dir) => {
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath: join(dir, 'cache.json'),
      fetcher: async () => jsonResponse(validMarketplace([])),
    })

    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.state, 'empty')
    assert.deepEqual(result.marketplace.plugins, [])
  })
}

async function testOfflineWithCacheServesStaleState(): Promise<void> {
  await withTempDir(async (dir) => {
    const responses: Array<Response | Error> = [
      jsonResponse(validMarketplace(), { headers: { etag: '"v1"' } }),
      new Error('network unavailable'),
    ]
    const fetcher: MarketplaceRegistryFetch = async () => {
      const response = responses.shift()
      assert.ok(response, 'test fetcher exhausted')
      if (response instanceof Error) throw response
      return response
    }
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath: join(dir, 'cache.json'),
      fetcher,
      now: () => new Date('2026-06-16T00:00:00.000Z'),
    })

    await client.read()
    const stale = await client.read()

    assert.equal(stale.ok, true)
    if (!stale.ok) return
    assert.equal(stale.state, 'offline')
    assert.equal(stale.stale, true)
    assert.equal(stale.source, 'cache')
    assert.match(stale.message, /offline|network unavailable/i)
    assert.equal(stale.marketplace.plugins[0].id, 'dev-helper')
  })
}

async function testOfflineWithoutCacheIsExplicitFailure(): Promise<void> {
  await withTempDir(async (dir) => {
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath: join(dir, 'cache.json'),
      fetcher: async () => {
        throw new Error('dns lookup failed')
      },
    })

    const result = await client.read()

    assert.deepEqual(
      { ok: result.ok, state: result.state, stale: result.stale },
      { ok: false, state: 'offline', stale: false }
    )
    assert.match(result.message, /dns lookup failed/)
  })
}

async function testFetchErrorIsDistinct(): Promise<void> {
  await withTempDir(async (dir) => {
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath: join(dir, 'cache.json'),
      fetcher: async () => new Response('missing', { status: 404 }),
    })

    const result = await client.read()

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.state, 'fetch-error')
    assert.equal(result.statusCode, 404)
  })
}

async function testInvalidSchemaDoesNotSilentlyUseCache(): Promise<void> {
  await withTempDir(async (dir) => {
    const responses = [
      jsonResponse(validMarketplace()),
      jsonResponse({ schemaVersion: 1, plugins: [{ id: '' }] }),
    ]
    const fetcher: MarketplaceRegistryFetch = async () => {
      const response = responses.shift()
      assert.ok(response, 'test fetcher exhausted')
      return response
    }
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath: join(dir, 'cache.json'),
      fetcher,
    })

    await client.read()
    const invalid = await client.read({ forceRefresh: true })

    assert.equal(invalid.ok, false)
    if (invalid.ok) return
    assert.equal(invalid.state, 'invalid-schema')
    assert.ok(invalid.issues?.length)
  })
}

async function testRejectsNonHttpsRegistryUrl(): Promise<void> {
  await withTempDir(async (dir) => {
    let fetched = false
    const client = new MarketplaceRegistryClient({
      registryUrl: 'http://example.com/marketplace.json',
      cachePath: join(dir, 'cache.json'),
      fetcher: async () => {
        fetched = true
        return jsonResponse(validMarketplace())
      },
    })

    const result = await client.read()

    assert.equal(result.ok, false)
    assert.equal(result.state, 'fetch-error')
    assert.match(result.message, /HTTPS/)
    assert.equal(fetched, false)
  })
}

async function testRegistryIpcChannel(): Promise<void> {
  const expected: MarketplaceRegistryReadResult = {
    ok: true,
    state: 'empty',
    registryUrl: REGISTRY_URL,
    source: 'network',
    stale: false,
    fetchedAt: '2026-06-16T00:00:00.000Z',
    marketplace: validMarketplace([]),
  }
  const ipcMain = createIpcMain()
  registerMarketplaceRegistryIpc(ipcMain as unknown as Parameters<typeof registerMarketplaceRegistryIpc>[0], {
    read: async (input) => {
      assert.deepEqual(input, { forceRefresh: true })
      return expected
    },
  })

  const handler = ipcMain.handlers.get('marketplace:registry:read')
  assert.ok(handler, 'marketplace registry channel should be registered')

  const result = (await handler?.(null, { forceRefresh: true })) as MarketplaceRegistryReadResult
  assert.deepEqual(result, expected)

  const invalid = (await handler?.(null, 'bad-input')) as MarketplaceRegistryReadResult
  assert.equal(invalid.ok, false)
  assert.equal(invalid.state, 'fetch-error')
}

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handle(channel, handler): void {
      handlers.set(channel, handler)
    },
    handlers,
  }
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
