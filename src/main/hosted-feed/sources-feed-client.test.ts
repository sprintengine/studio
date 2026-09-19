// The hosted sources feed's client and its schema gate (MC-2519).
//
// Same five rules as the model feed's client — remote > cache > seed with a
// newer seed winning, one fetch per TTL, a retry gap after a failure, ETag/304,
// and a rejected body that never reaches the cache — plus the two rules only
// this feed has: what a recommendation de-duplicates against, and what the
// parser refuses.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  hostedSourceId,
  parseHostedSourcesFeed,
  recommendedSourcesToAdd,
  type HostedSourcesFeed,
} from '../../shared/hosted-sources-feed'
import { ALWAYS_PRESENT_SKILL_SOURCE_IDS } from '../../shared/skills'
import {
  HostedSourcesFeedClient,
  configuredSourcesFeedUrl,
  sourcesFeedSeedCandidates,
  type SourcesFeedFetch,
} from './sources-feed-client'
import { test } from 'vitest'

test('sources-feed-client', async () => {
  const FEED_URL = 'https://example.com/sources.json'

  const feed = (updatedAt: string, repos: string[]): HostedSourcesFeed => ({
    schemaVersion: 1,
    updatedAt,
    sources: repos.map((repo) => ({
      id: repo.split('/')[1]!,
      repo,
      kind: 'claude-marketplace' as const,
      description: `Plugins from ${repo}.`,
    })),
  })

  type Call = { url: string; headers: Record<string, string> }

  function fetcherFor(
    respond: (call: Call, index: number) => Response | Error,
    calls: Call[] = [],
  ): { fetcher: SourcesFeedFetch; calls: Call[] } {
    const fetcher: SourcesFeedFetch = async (url, init) => {
      const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}))
      const call = { url, headers }
      calls.push(call)
      const out = respond(call, calls.length - 1)
      if (out instanceof Error) throw out
      return out
    }
    return { fetcher, calls }
  }

  const json = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    })

  async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'sources-feed-'))
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  let clock = Date.parse('2026-09-08T12:00:00Z')
  const now = (): Date => new Date(clock)
  const advance = (ms: number): void => {
    clock += ms
  }

  async function main(): Promise<void> {
    // ── The schema gate ───────────────────────────────────────────────────────
    {
      const good = parseHostedSourcesFeed(JSON.stringify(feed('2026-09-08T00:00:00Z', ['anthropics/skills'])))
      assert.ok(good.ok)
      assert.deepEqual(
        good.feed.sources.map((source) => source.repo),
        ['anthropics/skills'],
      )

      const refuses = (body: unknown, pattern: RegExp): void => {
        const result = parseHostedSourcesFeed(typeof body === 'string' ? body : JSON.stringify(body))
        assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(body).slice(0, 60)}`)
        if (!result.ok) assert.match(result.message, pattern)
      }
      refuses('{ not json', /not valid JSON/)
      refuses({ ...feed('2026-09-08T00:00:00Z', ['a/b']), schemaVersion: 7 }, /schemaVersion/)
      refuses({ schemaVersion: 1, updatedAt: 'someday', sources: [] }, /ISO `updatedAt`/)
      refuses({ schemaVersion: 1, updatedAt: '2026-09-08T00:00:00Z' }, /`sources` array/)
      // A repository, never a URL, and never a path that could climb out of one.
      refuses(
        {
          schemaVersion: 1,
          updatedAt: '2026-09-08T00:00:00Z',
          sources: [{ id: 'x', repo: 'https://github.com/a/b', kind: 'claude-marketplace', description: 'x' }],
        },
        /owner\/name/,
      )
      refuses(
        {
          schemaVersion: 1,
          updatedAt: '2026-09-08T00:00:00Z',
          sources: [{ id: 'x', repo: '../..', kind: 'claude-marketplace', description: 'x' }],
        },
        /owner\/name/,
      )
      // The `kind` vocabulary is the one `deriveShape` returns, and nothing else.
      refuses(
        {
          schemaVersion: 1,
          updatedAt: '2026-09-08T00:00:00Z',
          sources: [{ id: 'x', repo: 'a/b', kind: 'mcp-catalogue', description: 'x' }],
        },
        /kind/,
      )
      // Two rows for one repository would offer the same Add twice, and the
      // second could never be added because the first claimed the id.
      refuses(
        {
          schemaVersion: 1,
          updatedAt: '2026-09-08T00:00:00Z',
          sources: [
            { id: 'one', repo: 'a/b', kind: 'skills', description: 'x' },
            { id: 'two', repo: 'a/b', kind: 'skills', description: 'y' },
          ],
        },
        /repeats the repository/,
      )
      refuses(
        {
          schemaVersion: 1,
          updatedAt: '2026-09-08T00:00:00Z',
          sources: [
            { id: 'one', repo: 'a/b', kind: 'skills', description: 'x' },
            { id: 'one', repo: 'c/d', kind: 'skills', description: 'y' },
          ],
        },
        /repeats the id/,
      )
      // A row with nothing to say about itself is a row nobody can judge.
      refuses(
        {
          schemaVersion: 1,
          updatedAt: '2026-09-08T00:00:00Z',
          sources: [{ id: 'x', repo: 'a/b', kind: 'skills', description: '  ' }],
        },
        /no description/,
      )
    }

    // ── The de-duplication ────────────────────────────────────────────────────
    {
      const list = feed('2026-09-08T00:00:00Z', [
        'anthropics/claude-plugins-official',
        'sprintengine/studio-releases',
        'wshobson/agents',
      ])
      // The two the app always ships fall out: the store holds them and refuses
      // to remove them, so an Add for either could only report a failure.
      assert.deepEqual(
        recommendedSourcesToAdd(list, ALWAYS_PRESENT_SKILL_SOURCE_IDS).map((source) => source.repo),
        ['wshobson/agents'],
      )
      // And so does a source the person added themselves.
      assert.deepEqual(
        recommendedSourcesToAdd(list, [...ALWAYS_PRESENT_SKILL_SOURCE_IDS, 'github:wshobson/agents']).map(
          (s) => s.repo,
        ),
        [],
      )
      // Case-folded: GitHub treats `WsHobson` and `wshobson` as one owner, and a
      // rule that did not would be one capital letter from listing it twice.
      assert.deepEqual(
        recommendedSourcesToAdd(list, ['github:WsHobson/Agents'])
          .map((source) => source.repo)
          .sort(),
        ['anthropics/claude-plugins-official', 'sprintengine/studio-releases'],
      )
      // A local folder source shares no id space with a repository, so it never
      // suppresses a recommendation.
      assert.equal(recommendedSourcesToAdd(list, ['local:/Users/me/skills']).length, 3)
      // No feed at all is no recommendations, not a crash.
      assert.deepEqual(recommendedSourcesToAdd(null, []), [])
      // The id a recommendation would be added under is the one `addSource` mints.
      assert.equal(hostedSourceId('wshobson/agents'), 'github:wshobson/agents')
    }

    // ── remote > cache > seed, the TTL, the ETag, and the 304 ─────────────────
    await withDir(async (dir) => {
      const { fetcher, calls } = fetcherFor(() =>
        json(feed('2026-09-08T00:00:00Z', ['anthropics/skills']), { headers: { etag: '"v1"' } }),
      )
      const client = new HostedSourcesFeedClient({
        feedUrl: FEED_URL,
        cachePath: join(dir, 'cache.json'),
        fetcher,
        now,
      })
      const result = await client.read()
      assert.ok(result.ok)
      assert.equal(result.source, 'network')
      assert.equal(result.changed, true)
      assert.equal(result.etag, '"v1"')
      assert.deepEqual(
        result.feed.sources.map((source) => source.repo),
        ['anthropics/skills'],
      )
      assert.equal(calls.length, 1)
      assert.equal(calls[0]!.headers['if-none-match'], undefined)

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
      const notModified = await new HostedSourcesFeedClient({
        feedUrl: FEED_URL,
        cachePath: join(dir, 'cache.json'),
        fetcher: f304,
        now,
      }).read()
      assert.ok(notModified.ok)
      assert.equal(notModified.source, 'cache')
      assert.equal(notModified.notModified, true)
      assert.equal(notModified.changed, false)
      assert.equal(calls[1]!.headers['if-none-match'], '"v1"')

      // `cachedOnly` never touches the network: it is how the Extensions door
      // draws on open without waiting out a fetch.
      const disk = await new HostedSourcesFeedClient({
        feedUrl: FEED_URL,
        cachePath: join(dir, 'cache.json'),
        fetcher: fetcherFor(() => new Error('the network must not be reached')).fetcher,
        now,
      }).read({ cachedOnly: true })
      assert.ok(disk.ok)
      assert.equal(disk.source, 'cache')
    })

    // A rejected body is never cached; the last good copy is served as degraded
    // with the reason.
    await withDir(async (dir) => {
      const cachePath = join(dir, 'cache.json')
      const { fetcher: good } = fetcherFor(() =>
        json(feed('2026-09-08T00:00:00Z', ['anthropics/skills']), { headers: { etag: '"v1"' } }),
      )
      await new HostedSourcesFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: good, now }).read()
      const before = await readFile(cachePath, 'utf8')
      for (const body of [
        '{ not json',
        JSON.stringify({ ...feed('2026-09-09T00:00:00Z', ['a/b']), schemaVersion: 7 }),
      ]) {
        const { fetcher: bad } = fetcherFor(() => json(body))
        const result = await new HostedSourcesFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: bad, now }).read({
          forceRefresh: true,
        })
        assert.ok(result.ok)
        assert.equal(result.state, 'degraded')
        assert.equal(result.source, 'cache')
        assert.ok(result.message && result.message.length > 0)
        assert.deepEqual(
          result.feed.sources.map((source) => source.repo),
          ['anthropics/skills'],
        )
        assert.equal(await readFile(cachePath, 'utf8'), before, 'a rejected body never reaches the cache')
      }
    })

    // Offline: the seed when there is no cache, a typed failure when there is
    // neither, and the retry gap in between.
    await withDir(async (dir) => {
      const cachePath = join(dir, 'cache.json')
      const seedPath = join(dir, 'sources.json')
      await writeFile(seedPath, JSON.stringify(feed('2026-09-08T00:00:00Z', ['anthropics/skills'])), 'utf8')

      const { fetcher: offline, calls } = fetcherFor(() => new Error('getaddrinfo ENOTFOUND'))
      const withSeed = await new HostedSourcesFeedClient({
        feedUrl: FEED_URL,
        cachePath,
        fetcher: offline,
        now,
        packagedSeedPath: seedPath,
      }).read()
      assert.ok(withSeed.ok)
      assert.equal(withSeed.source, 'seed')
      assert.equal(withSeed.state, 'degraded')
      assert.match(withSeed.message ?? '', /Couldn't reach GitHub/)

      // With neither cache nor seed the result is a typed failure, and the
      // surface then simply shows no recommendations.
      const bare = new HostedSourcesFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: offline, now })
      const failed = await bare.read()
      assert.equal(failed.ok, false)
      if (!failed.ok) {
        assert.equal(failed.state, 'offline')
        assert.equal(failed.feedUrl, FEED_URL)
        assert.ok(failed.message.length > 0)
      }

      // The retry gap: a second read inside it does not ask again.
      const before = calls.length
      await bare.read()
      assert.equal(calls.length, before, 'no second attempt inside the retry gap')

      // A seed newer than the cache outranks it, so a release can correct the
      // recommended list before the next successful fetch.
      const { fetcher: served } = fetcherFor(() => json(feed('2026-09-08T00:00:00Z', ['old/one'])))
      await new HostedSourcesFeedClient({ feedUrl: FEED_URL, cachePath, fetcher: served, now }).read({
        forceRefresh: true,
      })
      await writeFile(seedPath, JSON.stringify(feed('2026-09-20T00:00:00Z', ['new/one'])), 'utf8')
      const seedWins = await new HostedSourcesFeedClient({
        feedUrl: FEED_URL,
        cachePath,
        fetcher: fetcherFor(() => new Error('offline')).fetcher,
        now,
        packagedSeedPath: seedPath,
      }).read({ cachedOnly: true })
      assert.ok(seedWins.ok)
      assert.equal(seedWins.source, 'seed')
      assert.deepEqual(
        seedWins.feed.sources.map((source) => source.repo),
        ['new/one'],
      )
    })

    // ── The URL and the seed's whereabouts ────────────────────────────────────
    {
      assert.match(configuredSourcesFeedUrl({} as NodeJS.ProcessEnv), /^https:\/\/raw\.githubusercontent\.com\//)
      assert.equal(
        configuredSourcesFeedUrl({ MULTICODE_SOURCES_FEED_URL: 'https://example.test/s.json' } as NodeJS.ProcessEnv),
        'https://example.test/s.json',
      )
      // HTTPS is enforced at read time, not by the override.
      const insecure = await new HostedSourcesFeedClient({
        feedUrl: 'http://example.com/sources.json',
        cachePath: '/nowhere/cache.json',
        fetcher: fetcherFor(() => new Error('must not be reached')).fetcher,
        now,
      }).read()
      assert.equal(insecure.ok, false)
      if (!insecure.ok) assert.match(insecure.message, /HTTPS/)

      assert.deepEqual(
        sourcesFeedSeedCandidates({ isPackaged: true, resourcesPath: '/app/Resources', appPath: '/app/app.asar' }),
        ['/app/Resources/sources.json', '/app/app.asar/resources/sources.json'],
      )
      assert.deepEqual(sourcesFeedSeedCandidates({ isPackaged: false, cwd: '/repo', appPath: null }), [
        '/repo/resources/sources.json',
      ])
    }

    console.log('sources feed client tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
