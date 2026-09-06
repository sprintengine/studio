import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HostedCardFeedClient, cardFeedSeedCandidates, configuredCardFeedUrl, type CardFeedFetch } from './card-feed-client'
import { parseHostedCardFeed } from '../../shared/hosted-card-feed'

const FEED_URL = 'https://example.com/cards-feed.json'

const card = (slug: string) => ({
  slug,
  kind: 'mcp',
  title: `Let an agent do ${slug}`,
  dek: 'Two or three sentences that make the claim.',
  art: 'browser',
  publishedAt: '2026-09-04',
  go: [{ verb: 'install.mcp', source: 'builtin', id: slug }],
})

const feed = (updatedAt: string, slugs: string[]) => ({
  schemaVersion: 1,
  updatedAt,
  cards: slugs.map((slug) => card(slug)),
})

type Call = { url: string; headers: Record<string, string> }

function fetcherFor(
  respond: (call: Call, index: number) => Response | Error,
  calls: Call[] = [],
): { fetcher: CardFeedFetch; calls: Call[] } {
  const fetcher: CardFeedFetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}))
    const call = { url, headers }
    calls.push(call)
    const out = respond(call, calls.length - 1)
    if (out instanceof Error) throw out
    return out
  }
  return { fetcher, calls }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'card-feed-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

let clock = Date.parse('2026-09-06T12:00:00Z')
const now = () => new Date(clock)
const advance = (ms: number) => {
  clock += ms
}

async function main(): Promise<void> {
  // Live fetch: parsed, cached with its ETag, reported as network and changed.
  await withDir(async (dir) => {
    const { fetcher, calls } = fetcherFor(() => json(feed('2026-09-06T00:00:00Z', ['drives-your-browser']), { headers: { etag: '"v1"' } }))
    const client = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'cache.json'), fetcher, now })
    const result = await client.read()
    assert.ok(result.ok)
    assert.equal(result.source, 'network')
    assert.equal(result.changed, true)
    assert.equal(result.etag, '"v1"')
    assert.deepEqual(result.feed.cards.map((c) => c.slug), ['drives-your-browser'])
    const cache = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8'))
    assert.equal(cache.etag, '"v1"')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers['if-none-match'], undefined)

    // Within the TTL a read serves the cache without a request.
    advance(10 * 60 * 1000)
    const again = await client.read()
    assert.ok(again.ok)
    assert.equal(again.source, 'cache')
    assert.equal(again.changed, false)
    assert.equal(calls.length, 1, 'no fetch inside the TTL')

    // After the TTL the ETag goes up and a 304 refreshes fetchedAt only.
    advance(60 * 60 * 1000)
    const { fetcher: f304 } = fetcherFor(() => new Response(null, { status: 304 }), calls)
    const client304 = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'cache.json'), fetcher: f304, now })
    const notModified = await client304.read()
    assert.ok(notModified.ok)
    assert.equal(notModified.source, 'cache')
    assert.equal(notModified.notModified, true)
    assert.equal(notModified.changed, false)
    assert.equal(calls[1].headers['if-none-match'], '"v1"')

    // forceRefresh skips the TTL and the ETag.
    const { fetcher: fForce } = fetcherFor(
      () => json(feed('2026-09-07T00:00:00Z', ['drives-your-browser', 'in-your-telegram']), { headers: { etag: '"v2"' } }),
      calls,
    )
    const forced = await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'cache.json'), fetcher: fForce, now }).read({ forceRefresh: true })
    assert.ok(forced.ok)
    assert.equal(forced.source, 'network')
    assert.equal(forced.changed, true)
    assert.equal(calls[2].headers['if-none-match'], undefined)
  })

  // A malformed body and an unknown schema are never cached; the last good copy
  // is served as degraded with the reason.
  await withDir(async (dir) => {
    const cachePath = join(dir, 'cache.json')
    const { fetcher: good } = fetcherFor(() => json(feed('2026-09-06T00:00:00Z', ['a']), { headers: { etag: '"v1"' } }))
    await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: good, now }).read()
    const before = await readFile(cachePath, 'utf8')
    for (const body of ['{ not json', JSON.stringify({ ...feed('2026-09-07T00:00:00Z', ['b']), schemaVersion: 7 })]) {
      const { fetcher: bad } = fetcherFor(() => json(body))
      const result = await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: bad, now }).read({ forceRefresh: true })
      assert.ok(result.ok)
      assert.equal(result.state, 'degraded')
      assert.equal(result.source, 'cache')
      assert.ok(result.message && result.message.length > 0)
      assert.deepEqual(result.feed.cards.map((c) => c.slug), ['a'])
      assert.equal(await readFile(cachePath, 'utf8'), before, 'a rejected body never reaches the cache')
    }
  })

  // One bad card is dropped and counted; the rest of the feed still renders,
  // and what lands in the cache is the surviving rows, not the raw body.
  await withDir(async (dir) => {
    const cachePath = join(dir, 'cache.json')
    const body = {
      schemaVersion: 1,
      updatedAt: '2026-09-06T00:00:00Z',
      cards: [
        card('keeps'),
        { ...card('no-art'), art: 'https://example.com/pretty.png' },
        { ...card('unknown-verb'), go: [{ verb: 'exec.shell', command: 'rm -rf /' }] },
        card('also-keeps'),
      ],
    }
    const { fetcher } = fetcherFor(() => json(body))
    const result = await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher, now }).read()
    assert.ok(result.ok)
    assert.equal(result.state, 'ok', 'a droppable row is not a failed read')
    assert.equal(result.dropped, 2)
    assert.deepEqual(result.feed.cards.map((c) => c.slug), ['keeps', 'also-keeps'])
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.deepEqual(cached.feed.cards.map((c: { slug: string }) => c.slug), ['keeps', 'also-keeps'], 'the dropped rows do not revive from disk')
  })

  // Offline: the cache if there is one, else the bundled seed, else a failure.
  // After a failure the client waits the retry gap before asking again.
  await withDir(async (dir) => {
    const seedPath = join(dir, 'seed.json')
    await writeFile(seedPath, JSON.stringify(feed('2026-08-01T00:00:00Z', ['seeded'])))
    const { fetcher, calls } = fetcherFor(() => new Error('ENOTFOUND'))
    const client = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'cache.json'), fetcher, now, packagedSeedPath: seedPath })
    const fromSeed = await client.read()
    assert.ok(fromSeed.ok)
    assert.equal(fromSeed.source, 'seed')
    assert.equal(fromSeed.state, 'degraded')
    assert.match(fromSeed.message ?? '', /Couldn't reach GitHub/)
    assert.deepEqual(fromSeed.feed.cards.map((c) => c.slug), ['seeded'])
    await client.read()
    assert.equal(calls.length, 1, 'inside the retry gap no second request is made')
    advance(6 * 60 * 1000)
    await client.read()
    assert.equal(calls.length, 2, 'after the retry gap it tries again')
    // The second failure re-arms the gap rather than letting the next read spin.
    await client.read()
    assert.equal(calls.length, 2, 'a failure inside the gap re-arms it')

    const bare = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'none.json'), fetcher, now })
    const failed = await bare.read()
    assert.equal(failed.ok, false)
    assert.equal(failed.ok ? '' : failed.state, 'offline')
  })

  // The first live fetch on a machine with a seed and no cache reports
  // `changed` even when the body is the seed byte for byte: the cache went from
  // nothing to something, and the page that opened on the seed needs the read to
  // learn the live copy is in hand.
  await withDir(async (dir) => {
    const seedPath = join(dir, 'seed.json')
    const body = feed('2026-09-01T00:00:00Z', ['seeded'])
    await writeFile(seedPath, JSON.stringify(body))
    const { fetcher, calls } = fetcherFor(() => json(body, { headers: { etag: '"seed"' } }))
    const client = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'cache.json'), fetcher, now, packagedSeedPath: seedPath })
    const first = await client.read()
    assert.ok(first.ok)
    assert.equal(first.source, 'network')
    assert.equal(first.changed, true, 'seed -> first live copy writes the cache and says so')
    assert.equal(calls.length, 1)
    // The same body again, forced, is not a change: the cache already holds it.
    const again = await client.read({ forceRefresh: true })
    assert.ok(again.ok)
    assert.equal(again.changed, false)
  })

  // cachedOnly never touches the network and prefers the cache over the seed.
  await withDir(async (dir) => {
    const seedPath = join(dir, 'seed.json')
    await writeFile(seedPath, JSON.stringify(feed('2026-08-01T00:00:00Z', ['seeded'])))
    const { fetcher, calls } = fetcherFor(() => json(feed('2026-09-06T00:00:00Z', ['live'])))
    const client = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'cache.json'), fetcher, now, packagedSeedPath: seedPath })
    const seedOnly = await client.read({ cachedOnly: true })
    assert.ok(seedOnly.ok)
    assert.equal(seedOnly.source, 'seed')
    assert.equal(seedOnly.state, 'ok')
    assert.equal(calls.length, 0)
    await client.read({ forceRefresh: true })
    const cached = await client.read({ cachedOnly: true })
    assert.ok(cached.ok)
    assert.equal(cached.source, 'cache')
    assert.equal(calls.length, 1)
  })

  // The bundle wins by updatedAt: a seed edited after the cached copy replaces
  // it, and the next successful fetch replaces both.
  await withDir(async (dir) => {
    const cachePath = join(dir, 'cache.json')
    const seedPath = join(dir, 'seed.json')
    const { fetcher: old } = fetcherFor(() => json(feed('2026-08-01T00:00:00Z', ['old-cache'])))
    await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: old, now }).read()
    await writeFile(seedPath, JSON.stringify(feed('2026-09-01T00:00:00Z', ['newer-seed'])))
    const { fetcher: offline } = fetcherFor(() => new Error('offline'))
    const served = await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: offline, now, packagedSeedPath: seedPath }).read({ forceRefresh: true })
    assert.ok(served.ok)
    assert.equal(served.source, 'seed', 'a newer bundle outranks an older cache')
    assert.deepEqual(served.feed.cards.map((c) => c.slug), ['newer-seed'])
    const { fetcher: live } = fetcherFor(() => json(feed('2026-09-06T00:00:00Z', ['live'])))
    const fresh = await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: live, now, packagedSeedPath: seedPath }).read({ forceRefresh: true })
    assert.ok(fresh.ok)
    assert.equal(fresh.source, 'network')
    assert.equal(fresh.changed, true)
  })

  // HTTPS only, the env override, and the seed path candidates.
  {
    const bad = await new HostedCardFeedClient({ feedUrl: 'http://example.com/cards-feed.json', cachePath: '/nonexistent/cache.json', fetcher: async () => json({}) }).read()
    assert.equal(bad.ok, false)
    assert.match(bad.ok ? '' : bad.message, /HTTPS/)
    // The override goes through the same gate as the default.
    const overridden = await new HostedCardFeedClient({
      feedUrl: configuredCardFeedUrl({ MULTICODE_CARD_FEED_URL: 'http://localhost:8765/cards-feed.json' }),
      cachePath: '/nonexistent/cache.json',
      fetcher: async () => json({}),
    }).read()
    assert.equal(overridden.ok, false)
    assert.match(overridden.ok ? '' : overridden.message, /HTTPS/)
    assert.equal(configuredCardFeedUrl({}), 'https://raw.githubusercontent.com/sprintengine/studio-releases/main/cards-feed.json')
    assert.equal(configuredCardFeedUrl({ MULTICODE_CARD_FEED_URL: ' https://localhost:8765/cards-feed.json ' }), 'https://localhost:8765/cards-feed.json')
    assert.deepEqual(cardFeedSeedCandidates({ isPackaged: true, resourcesPath: '/app/Resources', appPath: '/app/Resources/app.asar' }), [
      '/app/Resources/cards-feed.json',
      '/app/Resources/app.asar/resources/cards-feed.json',
    ])
    assert.deepEqual(cardFeedSeedCandidates({ isPackaged: false, cwd: '/repo' }), ['/repo/resources/cards-feed.json'])
  }

  // The bundled seed this build ships is a feed this build reads, with no row
  // dropped: a card that fails the gate must never reach an installer.
  {
    // Read from the repo root: the npm script runs the bundle from there.
    const parsed = parseHostedCardFeed(await readFile(join(process.cwd(), 'resources/cards-feed.json'), 'utf8'))
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message)
    assert.equal(parsed.dropped, 0, parsed.dropReasons.join('; '))
    assert.equal(parsed.feed.cards.length, 7)
    assert.equal(parsed.feed.cards.filter((c) => c.hero === true).length, 1)
  }

  console.log('card-feed-client: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
