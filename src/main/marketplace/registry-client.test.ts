import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { MarketplaceRegistryReadResult } from '../../shared/electron-api'
import type { MarketplaceIndex } from '../../shared/marketplace'
import { registerMarketplaceRegistryIpc } from '../ipc/marketplace-registry-ipc'
import {
  DEFAULT_MARKETPLACE_REGISTRY_URL,
  MarketplaceRegistryClient,
  configuredMarketplaceRegistryUrl,
  type MarketplaceRegistryFetch,
} from './registry-client'
import { findMarketplaceResourcePath } from './resources'

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
  await testLiveSuccessPrecedesPackagedSeed()
  await testHttp404WithCacheServesStaleCacheBeforeSeed()
  await testHttp404WithoutCacheFallsBackToPackagedSeed()
  await testBundledDefaultServesPackagedSeedWithoutFetching()
  await testBundledDefaultFallsThroughWhenSeedUnreadable()
  await testBundledDefaultTracksEnvOverrideDetection()
  await testEnvOverrideConfiguresRegistryUrl()
  await testConfiguredUrlOverrideReadsIndexWithEtagRoundTrip()
  await testCatalogueAndGithubRawYieldEquivalentEntries()
  await testSeedFallbackFiresUnderNonDefaultUrl()
  await testMarketplaceResourceResolutionOrder()
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

function validPlugin(overrides: Partial<MarketplaceIndex['plugins'][number]> = {}): MarketplaceIndex['plugins'][number] {
  return {
    id: 'dev-helper',
    name: 'Dev Helper',
    publisher: { name: 'Multicode Labs', verified: true },
    summary: 'Adds development helpers.',
    category: 'dev-tools',
    icon: 'icons/dev-helper.svg',
    latest: 1,
    source: 'https://github.com/sprintengine/studio-releases/plugins/dev-helper',
    provides: ['mcp', 'skills'],
    signature: VALID_SIGNATURE,
    ...overrides,
  }
}

async function writeMarketplace(path: string, marketplace: MarketplaceIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
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
        source: 'https://github.com/sprintengine/studio-releases/plugins/second-helper',
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
      packagedSeedPath: null,
      fetcher: async () => {
        throw new Error('dns lookup failed')
      },
    })

    const result = await client.read()

    assert.deepEqual(
      { ok: result.ok, state: result.state, stale: result.stale },
      { ok: false, state: 'offline', stale: false }
    )
    if (result.ok) return
    assert.match(result.message, /dns lookup failed/)
  })
}

async function testFetchErrorIsDistinct(): Promise<void> {
  await withTempDir(async (dir) => {
    const client = new MarketplaceRegistryClient({
      registryUrl: REGISTRY_URL,
      cachePath: join(dir, 'cache.json'),
      packagedSeedPath: null,
      fetcher: async () => new Response('missing', { status: 404 }),
    })

    const result = await client.read()

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.state, 'fetch-error')
    assert.equal(result.statusCode, 404)
  })
}

async function testLiveSuccessPrecedesPackagedSeed(): Promise<void> {
  await withTempDir(async (dir) => {
    const seedPath = join(dir, 'seed', 'marketplace.json')
    await writeMarketplace(seedPath, validMarketplace([validPlugin({ id: 'seed-helper', name: 'Seed Helper' })]))
    const networkMarketplace = validMarketplace([validPlugin({ id: 'network-helper', name: 'Network Helper' })])
    const cachePath = join(dir, 'cache.json')
    const client = new MarketplaceRegistryClient({
      cachePath,
      packagedSeedPath: seedPath,
      fetcher: async () => jsonResponse(networkMarketplace, { headers: { etag: '"live"' } }),
      now: () => new Date('2026-06-16T00:00:00.000Z'),
    })

    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.source, 'network')
    assert.equal(result.state, 'ok')
    assert.equal(result.marketplace.plugins[0].id, 'network-helper')

    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as { marketplace?: MarketplaceIndex }
    assert.equal(cache.marketplace?.plugins[0]?.id, 'network-helper')
  })
}

async function testHttp404WithCacheServesStaleCacheBeforeSeed(): Promise<void> {
  await withTempDir(async (dir) => {
    const seedPath = join(dir, 'seed', 'marketplace.json')
    await writeMarketplace(seedPath, validMarketplace([validPlugin({ id: 'seed-helper', name: 'Seed Helper' })]))
    const cachedMarketplace = validMarketplace([validPlugin({ id: 'cached-helper', name: 'Cached Helper' })])
    const responses = [
      jsonResponse(cachedMarketplace, { headers: { etag: '"v1"' } }),
      new Response('missing', { status: 404 }),
    ]
    const client = new MarketplaceRegistryClient({
      cachePath: join(dir, 'cache.json'),
      packagedSeedPath: seedPath,
      fetcher: async () => {
        const response = responses.shift()
        assert.ok(response, 'test fetcher exhausted')
        return response
      },
      now: () => new Date('2026-06-16T00:00:00.000Z'),
    })

    await client.read()
    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.state, 'offline')
    assert.equal(result.source, 'cache')
    assert.equal(result.stale, true)
    assert.equal(result.marketplace.plugins[0].id, 'cached-helper')
    assert.match(result.message, /HTTP 404/)
  })
}

async function testHttp404WithoutCacheFallsBackToPackagedSeed(): Promise<void> {
  await withTempDir(async (dir) => {
    const seedPlugins = ['a', 'b', 'c', 'd'].map((id) =>
      validPlugin({
        id: `seed-${id}`,
        name: `Seed ${id.toUpperCase()}`,
        source: `https://github.com/sprintengine/studio-releases/plugins/seed-${id}`,
      })
    )
    const seedPath = join(dir, 'seed', 'marketplace.json')
    await writeMarketplace(seedPath, validMarketplace(seedPlugins))
    const cachePath = join(dir, 'cache.json')
    const client = new MarketplaceRegistryClient({
      cachePath,
      packagedSeedPath: seedPath,
      fetcher: async () => new Response('missing', { status: 404 }),
      now: () => new Date('2026-06-16T00:00:00.000Z'),
    })

    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.state, 'offline')
    assert.equal(result.source, 'seed')
    assert.equal(result.stale, false)
    assert.equal(result.registryUrl, DEFAULT_MARKETPLACE_REGISTRY_URL)
    assert.equal(result.fetchedAt, '2026-06-16T00:00:00.000Z')
    assert.equal(result.marketplace.plugins.length, 4)
    assert.match(result.message, /HTTP 404/)
    assert.match(result.message, /packaged marketplace registry seed/i)
    await assert.rejects(readFile(cachePath, 'utf8'), /ENOENT/)
  })
}

async function testBundledDefaultServesPackagedSeedWithoutFetching(): Promise<void> {
  await withTempDir(async (dir) => {
    const seedPath = join(dir, 'seed', 'marketplace.json')
    await writeMarketplace(seedPath, validMarketplace([validPlugin({ id: 'bundled-a' }), validPlugin({ id: 'bundled-b' })]))
    const client = new MarketplaceRegistryClient({
      cachePath: join(dir, 'cache.json'),
      packagedSeedPath: seedPath,
      preferBundledSeed: true,
      fetcher: async () => {
        throw new Error('bundled-first read must not touch the network')
      },
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    })

    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    // The bundled seed is the healthy default, never an offline notice.
    assert.equal(result.state, 'ok')
    assert.equal(result.source, 'bundled')
    assert.equal(result.stale, false)
    // fetchedAt is the seed file's mtime — the honest "data as of" moment —
    // never now(): a refresh must not report build-frozen data as fresh.
    const { stat } = await import('node:fs/promises')
    const seedStat = await stat(seedPath)
    assert.equal(result.fetchedAt, new Date(seedStat.mtimeMs).toISOString())
    assert.equal(result.marketplace.plugins.length, 2)
    assert.equal('message' in result, false)

    // The parse is cached: a second read serves the same object without
    // re-reading the file.
    const again = await client.read()
    assert.equal(again.ok && again.marketplace === result.marketplace, true)
  })
}

async function testBundledDefaultFallsThroughWhenSeedUnreadable(): Promise<void> {
  await withTempDir(async (dir) => {
    const marketplace = validMarketplace()
    const client = new MarketplaceRegistryClient({
      cachePath: join(dir, 'cache.json'),
      packagedSeedPath: join(dir, 'missing-seed.json'),
      preferBundledSeed: true,
      fetcher: async () => jsonResponse(marketplace, { headers: { etag: '"v1"' } }),
      now: () => new Date('2026-07-09T00:00:00.000Z'),
    })

    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    // Missing/corrupt seed: degrade to the normal remote flow, not a failure.
    assert.equal(result.source, 'network')
    assert.equal(result.state, 'ok')
  })
}

async function testBundledDefaultTracksEnvOverrideDetection(): Promise<void> {
  const { isMarketplaceRegistryOverrideConfigured } = await import('./registry-client')
  assert.equal(isMarketplaceRegistryOverrideConfigured({}), false)
  assert.equal(isMarketplaceRegistryOverrideConfigured({ MULTICODE_MARKETPLACE_REGISTRY_URL: '  ' }), false)
  assert.equal(
    isMarketplaceRegistryOverrideConfigured({ MULTICODE_MARKETPLACE_REGISTRY_URL: 'https://catalogue.example.com/v1/registry' }),
    true
  )
}

async function testEnvOverrideConfiguresRegistryUrl(): Promise<void> {
  assert.equal(
    DEFAULT_MARKETPLACE_REGISTRY_URL,
    'https://raw.githubusercontent.com/sprintengine/studio-releases/main/marketplace.json'
  )
  assert.equal(configuredMarketplaceRegistryUrl({}), DEFAULT_MARKETPLACE_REGISTRY_URL)
  assert.equal(
    configuredMarketplaceRegistryUrl({ MULTICODE_MARKETPLACE_REGISTRY_URL: '   ' }),
    DEFAULT_MARKETPLACE_REGISTRY_URL
  )
  assert.equal(
    configuredMarketplaceRegistryUrl({
      MULTICODE_MARKETPLACE_REGISTRY_URL: ' https://catalogue.example.com/v1/registry ',
    }),
    'https://catalogue.example.com/v1/registry'
  )
}

async function testConfiguredUrlOverrideReadsIndexWithEtagRoundTrip(): Promise<void> {
  await withTempDir(async (dir) => {
    const catalogueUrl = 'https://catalogue.example.com/v1/registry'
    const requests: FetchRequest[] = []
    const responses = [
      jsonResponse(validMarketplace(), { headers: { etag: '"cat-v1"' } }),
      notModifiedResponse('"cat-v1"'),
    ]
    const fetcher: MarketplaceRegistryFetch = async (url, init) => {
      requests.push({ url, init })
      const response = responses.shift()
      assert.ok(response, 'test fetcher exhausted')
      return response
    }
    const client = new MarketplaceRegistryClient({
      registryUrl: configuredMarketplaceRegistryUrl({ MULTICODE_MARKETPLACE_REGISTRY_URL: catalogueUrl }),
      cachePath: join(dir, 'cache.json'),
      fetcher,
      now: () => new Date('2026-06-16T00:00:00.000Z'),
    })

    const fresh = await client.read()

    assert.equal(fresh.ok, true)
    if (!fresh.ok) return
    assert.equal(fresh.state, 'ok')
    assert.equal(fresh.source, 'network')
    assert.equal(fresh.registryUrl, catalogueUrl)
    assert.equal(requests[0].url, catalogueUrl)

    const cached = await client.read()

    assert.equal(cached.ok, true)
    if (!cached.ok) return
    assert.equal(cached.state, 'ok')
    assert.equal(cached.source, 'cache')
    assert.equal(cached.notModified, true)
    assert.equal(cached.registryUrl, catalogueUrl)
    assert.equal(requestHeaders(requests[1].init)['if-none-match'], '"cat-v1"')
  })
}

async function testCatalogueAndGithubRawYieldEquivalentEntries(): Promise<void> {
  // Registry parity: a hosted catalogue endpoint (/v1/registry) and the
  // GitHub-raw default must be interchangeable transports — the SAME index bytes
  // read through either URL parse to identical entries, and each does the ETag
  // capture + 304-round-trip. Proves the client is transport-agnostic (a payload
  // that parses under one URL and not the other would be a real parity break).
  const payload = validMarketplace([
    validPlugin({ id: 'dev-helper', provides: ['mcp', 'skills'] }),
    validPlugin({ id: 'inline-weather', name: 'Weather', category: 'data', source: undefined, signature: undefined, provides: ['mcp'], mcp: { servers: [{ id: 'weather', name: 'Weather', transport: 'stdio', command: 'npx', args: ['weather-mcp'], enabled: true, clients: ['claude-code'], scope: 'workspace', source: 'custom', riskLevel: 'low' }] } }),
  ])

  async function readVia(registryUrl: string): Promise<MarketplaceRegistryReadResult> {
    return withTempDir(async (dir) => {
      const responses = [
        jsonResponse(payload, { headers: { etag: '"parity-v1"' } }),
        notModifiedResponse('"parity-v1"'),
      ]
      const requests: FetchRequest[] = []
      const fetcher: MarketplaceRegistryFetch = async (url, init) => {
        requests.push({ url, init })
        const response = responses.shift()
        assert.ok(response, 'test fetcher exhausted')
        return response
      }
      const client = new MarketplaceRegistryClient({
        registryUrl,
        cachePath: join(dir, 'cache.json'),
        fetcher,
        now: () => new Date('2026-06-16T00:00:00.000Z'),
      })
      const fresh = await client.read()
      assert.equal(fresh.ok, true)
      if (fresh.ok) assert.equal(fresh.registryUrl, registryUrl)
      // Second read exercises the ETag 304 round-trip under this URL.
      const cached = await client.read()
      assert.equal(cached.ok, true)
      // `notModified` lives only on the online success branch, so the read
      // staying online is part of what this asserts, not a precondition to skip.
      assert.notEqual(cached.state, 'offline', 'the cached read stays on the online branch')
      if (cached.ok && cached.state !== 'offline') assert.equal(cached.notModified, true)
      assert.equal(requestHeaders(requests[1].init)['if-none-match'], '"parity-v1"')
      return fresh
    })
  }

  const catalogueUrl = configuredMarketplaceRegistryUrl({ MULTICODE_MARKETPLACE_REGISTRY_URL: 'https://catalogue.example.com/v1/registry' })
  const githubRawUrl = configuredMarketplaceRegistryUrl({})
  assert.notEqual(catalogueUrl, githubRawUrl, 'the two transports must be distinct URLs')
  assert.equal(githubRawUrl, DEFAULT_MARKETPLACE_REGISTRY_URL)

  const fromCatalogue = await readVia(catalogueUrl)
  const fromGithubRaw = await readVia(githubRawUrl)
  assert.equal(fromCatalogue.ok, true)
  assert.equal(fromGithubRaw.ok, true)
  if (!fromCatalogue.ok || !fromGithubRaw.ok) return
  // The parsed entries are byte-for-byte equivalent regardless of transport.
  assert.deepEqual(fromCatalogue.marketplace.plugins, fromGithubRaw.marketplace.plugins)
  assert.equal(fromCatalogue.marketplace.plugins.length, 2)
}

async function testSeedFallbackFiresUnderNonDefaultUrl(): Promise<void> {
  await withTempDir(async (dir) => {
    const catalogueUrl = 'https://catalogue.example.com/v1/registry'
    const seedPath = join(dir, 'seed', 'marketplace.json')
    await writeMarketplace(seedPath, validMarketplace([validPlugin({ id: 'seed-helper', name: 'Seed Helper' })]))
    const client = new MarketplaceRegistryClient({
      registryUrl: catalogueUrl,
      cachePath: join(dir, 'cache.json'),
      packagedSeedPath: seedPath,
      fetcher: async () => {
        throw new Error('network unavailable')
      },
      now: () => new Date('2026-06-16T00:00:00.000Z'),
    })

    const result = await client.read()

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.state, 'offline')
    assert.equal(result.source, 'seed')
    assert.equal(result.stale, false)
    assert.equal(result.registryUrl, catalogueUrl)
    assert.equal(result.marketplace.plugins[0].id, 'seed-helper')
    assert.match(result.message, /packaged marketplace registry seed/i)
  })
}

async function testMarketplaceResourceResolutionOrder(): Promise<void> {
  await withTempDir(async (dir) => {
    const resourcesPath = join(dir, 'resourcesPath')
    const packagedCandidate = join(resourcesPath, 'marketplace', 'marketplace.json')
    assert.equal(
      findMarketplaceResourcePath('marketplace.json', {
        isPackaged: true,
        resourcesPath,
        appPath: join(dir, 'app'),
        exists: (candidate) => candidate === packagedCandidate,
      }),
      packagedCandidate
    )

    const appPath = join(dir, 'app')
    const appCandidate = join(appPath, 'resources', 'marketplace', 'marketplace.json')
    assert.equal(
      findMarketplaceResourcePath('marketplace.json', {
        isPackaged: true,
        resourcesPath,
        appPath,
        exists: (candidate) => candidate === appCandidate,
      }),
      appCandidate
    )

    const cwd = join(dir, 'repo')
    const cwdCandidate = join(cwd, 'resources', 'marketplace', 'marketplace.json')
    assert.equal(
      findMarketplaceResourcePath('marketplace.json', {
        isPackaged: false,
        cwd,
        appPath: null,
        dirname: join(cwd, 'out', 'main'),
        exists: (candidate) => candidate === cwdCandidate,
      }),
      cwdCandidate
    )

    const dirname = join(cwd, 'out', 'main')
    const dirnameCandidate = join(dirname, '..', '..', 'resources', 'marketplace', 'marketplace.json')
    assert.equal(
      findMarketplaceResourcePath('marketplace.json', {
        isPackaged: false,
        cwd,
        appPath: null,
        dirname,
        exists: (candidate) => candidate === dirnameCandidate,
      }),
      dirnameCandidate
    )

    assert.equal(
      findMarketplaceResourcePath('../marketplace.json', {
        isPackaged: false,
        cwd,
        appPath: null,
        dirname,
        exists: () => true,
      }),
      null
    )
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
