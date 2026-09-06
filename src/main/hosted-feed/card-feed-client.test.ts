import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HostedCardFeedClient, cardFeedSeedCandidates, configuredCardFeedUrl, type CardFeedFetch } from './card-feed-client'

const FEED_URL = 'https://example.com/cards-feed.json'

const card = (slug: string) => ({
  slug,
  kind: 'mcp',
  title: `Let an agent do ${slug}`,
  dek: 'Two or three sentences that make the claim.',
  art: 'browser',
  publishedAt: '2026-09-04',
  go: [{ verb: 'install.mcp', id: 'io-github-domdomegg-gmail-mcp' }],
})

// A row this build cannot read: the verb is not in the union, so the card is
// dropped and counted. Every "what happens to a row we cannot read" test uses
// it, because that is the case a downgrade produces in the field.
const unreadableCard = (slug: string) => ({ ...card(slug), go: [{ verb: 'exec.shell', command: 'rm -rf /' }] })

const feed = (updatedAt: string, slugs: string[]) => ({
  schemaVersion: 1,
  updatedAt,
  cards: slugs.map((slug) => card(slug)),
})

type Call = { url: string; headers: Record<string, string> }

function fetcherFor(
  respond: (call: Call, index: number) => Response | Error | Promise<Response>,
  calls: Call[] = [],
): { fetcher: CardFeedFetch; calls: Call[] } {
  const fetcher: CardFeedFetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}))
    const call = { url, headers }
    calls.push(call)
    const out = await respond(call, calls.length - 1)
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

const readCacheFile = async (path: string): Promise<{ etag?: string; fetchedAt: string; body: string }> =>
  JSON.parse(await readFile(path, 'utf8'))

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
    const cache = await readCacheFile(join(dir, 'cache.json'))
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

  // One bad card is dropped from what is SERVED and counted with its reason —
  // and the cache keeps the body whole, rows this build cannot read included.
  // The parsed feed used to be what was written, which meant a build that did
  // not know a verb truncated the cache and the next 304 wrote the truncation
  // back with the ETag intact: the card never returned. Storing the body keeps
  // the drop to this build's own reading of it.
  await withDir(async (dir) => {
    const cachePath = join(dir, 'cache.json')
    const body = {
      schemaVersion: 1,
      updatedAt: '2026-09-06T00:00:00Z',
      cards: [card('keeps'), { ...card('no-art'), art: 'https://example.com/pretty.png' }, unreadableCard('from-a-newer-build'), card('also-keeps')],
    }
    const { fetcher, calls } = fetcherFor(() => json(body, { headers: { etag: '"v1"' } }))
    const result = await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher, now }).read()
    assert.ok(result.ok)
    assert.equal(result.state, 'ok', 'a droppable row is not a failed read')
    assert.equal(result.dropped, 2)
    assert.equal(result.dropReasons?.length, 2)
    assert.deepEqual(result.feed.cards.map((c) => c.slug), ['keeps', 'also-keeps'])

    const cached = await readCacheFile(cachePath)
    assert.deepEqual(
      JSON.parse(cached.body).cards.map((c: { slug: string }) => c.slug),
      ['keeps', 'no-art', 'from-a-newer-build', 'also-keeps'],
      "the cache holds the body as received, not this build's reading of it",
    )

    // A 304 rewrites the same body with the same ETag, so the row a newer build
    // would show is still there afterwards.
    advance(2 * 60 * 60 * 1000)
    const { fetcher: f304 } = fetcherFor(() => new Response(null, { status: 304 }), calls)
    const notModified = await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: f304, now }).read()
    assert.ok(notModified.ok)
    assert.equal(notModified.notModified, true)
    assert.equal(notModified.dropped, 2, 'a cached copy reports what this build cannot read in it')
    const after = await readCacheFile(cachePath)
    assert.equal(after.etag, '"v1"')
    assert.equal(JSON.parse(after.body).cards.length, 4, 'a 304 never truncates the stored body')
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

  // EVERY failure path arms the retry gap, not only the thrown fetch. Each of
  // the five is run on a fresh client with nothing on disk, and the second read
  // must not reach the network. The schema case in particular is checked
  // WITHOUT forceRefresh: force skips the gap, so a forced read proves nothing
  // about it.
  {
    const failures: [string, () => Response | Error][] = [
      ['the fetch throws', () => new Error('ENOTFOUND')],
      ['GitHub answers 500', () => new Response('nope', { status: 500 })],
      ['GitHub answers 304 with nothing cached', () => new Response(null, { status: 304 })],
      [
        'the body cannot be read',
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('socket hung up'))
              },
            }),
            { status: 200 },
          ),
      ],
      ['the body fails the schema gate', () => json({ schemaVersion: 7, updatedAt: '2026-09-06T00:00:00Z', cards: [] })],
    ]
    for (const [what, respond] of failures) {
      await withDir(async (dir) => {
        const { fetcher, calls } = fetcherFor(respond)
        const client = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'cache.json'), fetcher, now })
        const first = await client.read()
        assert.equal(first.ok, false, `${what}: the read fails`)
        assert.equal(calls.length, 1, `${what}: one request`)
        const second = await client.read()
        assert.equal(second.ok, false)
        assert.equal(calls.length, 1, `${what}: the gap is armed, so no second request`)
        advance(6 * 60 * 1000)
        await client.read()
        assert.equal(calls.length, 2, `${what}: after the gap it tries again`)
      })
    }
  }

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

  // cachedOnly does not join a network read already in flight. The in-flight
  // guard used to hand back whatever promise was running, so the home page's
  // local read waited out the whole fetch timeout for an answer that was on
  // disk. Here the fetch hangs until the local read has already answered.
  await withDir(async (dir) => {
    const seedPath = join(dir, 'seed.json')
    await writeFile(seedPath, JSON.stringify(feed('2026-08-01T00:00:00Z', ['seeded'])))
    let release: (() => void) | null = null
    const hang = new Promise<void>((resolve) => {
      release = resolve
    })
    const { fetcher, calls } = fetcherFor(async () => {
      await hang
      return json(feed('2026-09-06T00:00:00Z', ['live']))
    })
    const client = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath: join(dir, 'cache.json'), fetcher, now, packagedSeedPath: seedPath })
    const inFlight = client.read()
    const local = await client.read({ cachedOnly: true })
    assert.ok(local.ok)
    assert.equal(local.source, 'seed', 'the local read answered while the fetch was still open')
    assert.equal(calls.length, 1, 'and it started no request of its own')
    release?.()
    const live = await inFlight
    assert.ok(live.ok)
    assert.equal(live.source, 'network')
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

  // A seed that outranks the cache is ADOPTED into it, and the TTL survives.
  // Preferring the seed without persisting it left the client with no cache to
  // measure the TTL against, so every single read went to the network — and the
  // seed a release ships is stamped later than the hosted file from the day it
  // is cut, which is exactly this state.
  await withDir(async (dir) => {
    const cachePath = join(dir, 'cache.json')
    const seedPath = join(dir, 'seed.json')
    const { fetcher: old, calls } = fetcherFor(() => json(feed('2026-08-01T00:00:00Z', ['old-cache']), { headers: { etag: '"old"' } }))
    await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: old, now }).read()
    const before = await readCacheFile(cachePath)
    await writeFile(seedPath, JSON.stringify(feed('2026-09-01T00:00:00Z', ['newer-seed'])))

    const { fetcher: live, calls: liveCalls } = fetcherFor(() => json(feed('2026-08-01T00:00:00Z', ['old-cache'])))
    const client = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: live, now, packagedSeedPath: seedPath })
    const served = await client.read()
    assert.ok(served.ok)
    assert.equal(served.source, 'seed')
    assert.equal(liveCalls.length, 0, 'the adopted seed is inside the TTL, so no request is made')

    const adopted = await readCacheFile(cachePath)
    assert.deepEqual(JSON.parse(adopted.body).cards.map((c: { slug: string }) => c.slug), ['newer-seed'], 'the seed was written through')
    assert.equal(adopted.fetchedAt, before.fetchedAt, 'adopting a bundled file is not a conversation with GitHub')
    assert.equal(adopted.etag, undefined, 'the old ETag identified a body that is no longer stored')

    // The next read finds cache and seed equal, so the seed no longer wins and
    // the copy is reported as what it now is.
    const second = await client.read()
    assert.ok(second.ok)
    assert.equal(second.source, 'cache')
    assert.equal(second.changed, false)
    assert.equal(liveCalls.length, 0, 'and the TTL still holds')
    assert.equal(calls.length, 1)
  })

  // What a local copy could not read is reported from the cache and from the
  // seed, not only from a fresh network body.
  await withDir(async (dir) => {
    const cachePath = join(dir, 'cache.json')
    const seedPath = join(dir, 'seed.json')
    await writeFile(
      seedPath,
      JSON.stringify({ schemaVersion: 1, updatedAt: '2026-09-01T00:00:00Z', cards: [card('seeded'), unreadableCard('from-a-newer-build')] }),
    )
    const { fetcher } = fetcherFor(() => new Error('offline'))
    const fromSeed = await new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher, now, packagedSeedPath: seedPath }).read({ cachedOnly: true })
    assert.ok(fromSeed.ok)
    assert.equal(fromSeed.source, 'seed')
    assert.equal(fromSeed.dropped, 1)
    assert.match(fromSeed.dropReasons?.[0] ?? '', /is not a verb this build implements/)

    const { fetcher: live } = fetcherFor(() =>
      json({ schemaVersion: 1, updatedAt: '2026-09-06T00:00:00Z', cards: [card('live'), unreadableCard('also-from-a-newer-build')] }),
    )
    const client = new HostedCardFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: live, now })
    const fresh = await client.read()
    assert.ok(fresh.ok)
    assert.equal(fresh.dropped, 1)
    const fromCache = await client.read({ cachedOnly: true })
    assert.ok(fromCache.ok)
    assert.equal(fromCache.source, 'cache')
    assert.equal(fromCache.dropped, 1)
    assert.match(fromCache.dropReasons?.[0] ?? '', /is not a verb this build implements/)
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
    // A cachedOnly read has its own path, and the URL gate is on that one too.
    const localOnly = await new HostedCardFeedClient({ feedUrl: 'http://example.com/cards-feed.json', cachePath: '/nonexistent/cache.json', fetcher: async () => json({}) }).read({ cachedOnly: true })
    assert.equal(localOnly.ok, false)
    assert.match(localOnly.ok ? '' : localOnly.message, /HTTPS/)
    assert.equal(configuredCardFeedUrl({}), 'https://raw.githubusercontent.com/sprintengine/studio-releases/main/cards-feed.json')
    assert.equal(configuredCardFeedUrl({ MULTICODE_CARD_FEED_URL: ' https://localhost:8765/cards-feed.json ' }), 'https://localhost:8765/cards-feed.json')
    assert.deepEqual(cardFeedSeedCandidates({ isPackaged: true, resourcesPath: '/app/Resources', appPath: '/app/Resources/app.asar' }), [
      '/app/Resources/cards-feed.json',
      '/app/Resources/app.asar/resources/cards-feed.json',
    ])
    assert.deepEqual(cardFeedSeedCandidates({ isPackaged: false, cwd: '/repo' }), ['/repo/resources/cards-feed.json'])
  }

  // The bundled seed itself is checked by scripts/check-card-feed-seed.mjs
  // (npm run test:card-feed), which resolves every id it names against the
  // catalogue and sources this repository ships. It does not belong here: this
  // file tests the client against feeds it makes up, and a self-check that only
  // asserted the seed parses was what let six unresolvable cards ship.

  console.log('card-feed-client: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
