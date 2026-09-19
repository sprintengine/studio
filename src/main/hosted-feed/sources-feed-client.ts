// Fetches the hosted sources feed (src/shared/hosted-sources-feed.ts) the way
// model-feed-client.ts fetches the model feed: HTTPS only, ETag/304, a cache
// file under userData, a bundled seed for the first boot and for offline, and
// honest source/state reporting. Deliberately a sibling and not a shared
// abstraction over the three feeds — the card feed states the reason and it
// holds here too: the schemas ship on their own clocks and must be free to
// drift, and a shared client would make one feed's change the others' problem.
//
// The rules the feed follows:
//   - precedence is remote > disk cache > bundled seed, EXCEPT a seed whose
//     `updatedAt` is newer than the cache wins, so a release can correct the
//     recommended list before the next successful fetch;
//   - a fetch is attempted at most once per TTL, and after a failure not again
//     for the retry gap, so an offline machine never pays a timeout on every
//     read;
//   - a body that fails the schema gate is never written to cache. The last
//     good copy stays and the result says why.
//
// A failure is never fatal to the surface that reads it: a studio with no feed
// at all shows no recommendations, which is the same thing it showed before
// this feed existed.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import type { HostedSourcesFeedReadInput, HostedSourcesFeedReadResult } from '../../shared/electron-api'
import {
  HOSTED_SOURCES_FEED_URL,
  hostedSourcesFeedUpdatedAtMs,
  parseHostedSourcesFeed,
  type HostedSourcesFeed,
} from '../../shared/hosted-sources-feed'
import { readStudioEnv } from '../../shared/studio-env'

const SOURCES_FEED_CACHE_FILENAME = 'sources-feed-cache.json'
const SOURCES_FEED_SEED_FILENAME = 'sources.json'
const DEFAULT_SOURCES_FEED_TIMEOUT_MS = 10_000
// One fetch an hour, and one retry every five minutes after a failure.
const SOURCES_FEED_TTL_MS = 60 * 60 * 1_000
const SOURCES_FEED_RETRY_MS = 5 * 60 * 1_000

// SPRINTENGINE_SOURCES_FEED_URL points the client at another copy of the file — a
// local static server while developing, a fork's raw URL — with every other
// rule (ETag, cache, seed, schema gate) unchanged. HTTPS only, like the default.
export function configuredSourcesFeedUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = readStudioEnv('SPRINTENGINE_SOURCES_FEED_URL', env)?.trim()
  return override || HOSTED_SOURCES_FEED_URL
}

export function defaultSourcesFeedCachePath(userDataDir: string): string {
  return join(userDataDir, SOURCES_FEED_CACHE_FILENAME)
}

// Where the bundled seed lives: `resources/sources.json` in a checkout, copied
// to the resources root by build.extraResources in a packaged app.
export function sourcesFeedSeedCandidates(options: {
  isPackaged: boolean
  resourcesPath?: string
  appPath?: string | null
  cwd?: string
}): string[] {
  const candidates: string[] = []
  if (options.isPackaged) {
    if (options.resourcesPath) candidates.push(join(options.resourcesPath, SOURCES_FEED_SEED_FILENAME))
    if (options.appPath) candidates.push(join(options.appPath, 'resources', SOURCES_FEED_SEED_FILENAME))
    return candidates
  }
  if (options.cwd) candidates.push(join(options.cwd, 'resources', SOURCES_FEED_SEED_FILENAME))
  if (options.appPath) candidates.push(join(options.appPath, 'resources', SOURCES_FEED_SEED_FILENAME))
  return candidates.filter((candidate) => isAbsolute(candidate))
}

export type SourcesFeedFetch = (url: string, init: RequestInit) => Promise<Response>

export type HostedSourcesFeedClientOptions = {
  feedUrl?: string
  cachePath: string
  fetcher?: SourcesFeedFetch
  timeoutMs?: number
  now?: () => Date
  // Absolute path of the bundled seed; null disables the seed fallback.
  packagedSeedPath?: string | null
  ttlMs?: number
  retryMs?: number
}

type CacheFile = {
  schemaVersion: 1
  feedUrl: string
  etag?: string
  fetchedAt: string
  feed: HostedSourcesFeed
}

export class HostedSourcesFeedClient {
  private readonly feedUrl: string
  private readonly cachePath: string
  private readonly fetcher: SourcesFeedFetch
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly packagedSeedPath: string | null
  private readonly ttlMs: number
  private readonly retryMs: number
  private lastFailureAtMs: number | null = null
  private inFlight: Promise<HostedSourcesFeedReadResult> | null = null

  constructor(options: HostedSourcesFeedClientOptions) {
    this.feedUrl = (options.feedUrl ?? configuredSourcesFeedUrl()).trim()
    this.cachePath = options.cachePath
    this.fetcher = options.fetcher ?? defaultFetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SOURCES_FEED_TIMEOUT_MS
    this.now = options.now ?? (() => new Date())
    this.packagedSeedPath = options.packagedSeedPath ?? null
    this.ttlMs = options.ttlMs ?? SOURCES_FEED_TTL_MS
    this.retryMs = options.retryMs ?? SOURCES_FEED_RETRY_MS
  }

  // Never overlaps: a read during a scheduled tick joins the tick.
  read(input: HostedSourcesFeedReadInput = {}): Promise<HostedSourcesFeedReadResult> {
    if (this.inFlight) return this.inFlight
    const run = this.readOnce(input).finally(() => {
      if (this.inFlight === run) this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async readOnce(input: HostedSourcesFeedReadInput): Promise<HostedSourcesFeedReadResult> {
    const feedUrl = this.feedUrl
    const parsedUrl = parseHttpsUrl(feedUrl)
    if (!parsedUrl.ok) {
      return { ok: false, state: 'fetch-error', feedUrl, message: parsedUrl.message }
    }

    const seed = await this.readSeed()
    let cache = await this.readCache(feedUrl)
    // The bundled seed is the release's own list. A cache written before that
    // release carries older recommendations, and must not outrank it.
    if (cache && seed && hostedSourcesFeedUpdatedAtMs(seed) > hostedSourcesFeedUpdatedAtMs(cache.feed)) cache = null

    const nowMs = this.now().getTime()
    const force = input.forceRefresh === true
    if (input.cachedOnly === true) return this.serveLocal(feedUrl, cache, seed, undefined)
    if (!force && cache && nowMs - Date.parse(cache.fetchedAt) < this.ttlMs) {
      return this.serveLocal(feedUrl, cache, seed, undefined)
    }
    if (!force && this.lastFailureAtMs !== null && nowMs - this.lastFailureAtMs < this.retryMs) {
      return this.serveLocal(feedUrl, cache, seed, 'Waiting before trying GitHub again.')
    }

    let response: Response
    try {
      response = await this.fetchWithTimeout(parsedUrl.url, cache, force)
    } catch (error) {
      this.lastFailureAtMs = nowMs
      return this.serveLocal(feedUrl, cache, seed, `Couldn't reach GitHub. ${formatError(error)}`, 'offline')
    }

    if (response.status === 304) {
      if (!cache) {
        this.lastFailureAtMs = nowMs
        return {
          ok: false,
          state: 'fetch-error',
          feedUrl,
          statusCode: 304,
          message: 'GitHub answered 304 Not Modified, but there is no cached copy.',
        }
      }
      const touched: CacheFile = { ...cache, fetchedAt: this.now().toISOString() }
      await this.writeCache(touched)
      this.lastFailureAtMs = null
      return {
        ok: true,
        state: 'ok',
        feedUrl,
        source: 'cache',
        fetchedAt: touched.fetchedAt,
        ...(touched.etag ? { etag: touched.etag } : {}),
        notModified: true,
        changed: false,
        feed: touched.feed,
      }
    }

    if (!response.ok) {
      this.lastFailureAtMs = nowMs
      return this.serveLocal(
        feedUrl,
        cache,
        seed,
        `GitHub answered HTTP ${response.status}.`,
        'fetch-error',
        response.status,
      )
    }

    let body: string
    try {
      body = await response.text()
    } catch (error) {
      this.lastFailureAtMs = nowMs
      return this.serveLocal(
        feedUrl,
        cache,
        seed,
        `The sources feed could not be read. ${formatError(error)}`,
        'offline',
      )
    }

    const parsed = parseHostedSourcesFeed(body)
    if (!parsed.ok) {
      // Never cached. The last good copy stands and the line says why.
      this.lastFailureAtMs = nowMs
      return this.serveLocal(feedUrl, cache, seed, parsed.message, 'invalid-schema')
    }

    const etag = response.headers.get('etag') ?? undefined
    const fetchedAt = this.now().toISOString()
    // `changed` is "the cache on disk is now different", measured against the
    // cache alone. The first live fetch after install (no cache yet) counts
    // even when its body matches the bundled seed.
    const changed = !cache || JSON.stringify(cache.feed) !== JSON.stringify(parsed.feed)
    await this.writeCache({ schemaVersion: 1, feedUrl, ...(etag ? { etag } : {}), fetchedAt, feed: parsed.feed })
    this.lastFailureAtMs = null
    return {
      ok: true,
      state: 'ok',
      feedUrl,
      source: 'network',
      fetchedAt,
      ...(etag ? { etag } : {}),
      changed,
      feed: parsed.feed,
    }
  }

  // What to show when the network did not answer with a fresh body: the cache,
  // else the seed, else an explicit failure.
  private serveLocal(
    feedUrl: string,
    cache: CacheFile | null,
    seed: HostedSourcesFeed | null,
    message: string | undefined,
    failureState: 'offline' | 'fetch-error' | 'invalid-schema' = 'offline',
    statusCode?: number,
  ): HostedSourcesFeedReadResult {
    if (cache) {
      return {
        ok: true,
        state: message ? 'degraded' : 'ok',
        feedUrl,
        source: 'cache',
        fetchedAt: cache.fetchedAt,
        ...(cache.etag ? { etag: cache.etag } : {}),
        changed: false,
        feed: cache.feed,
        ...(message ? { message } : {}),
      }
    }
    if (seed) {
      return {
        ok: true,
        state: message ? 'degraded' : 'ok',
        feedUrl,
        source: 'seed',
        fetchedAt: seed.updatedAt,
        changed: false,
        feed: seed,
        ...(message ? { message } : {}),
      }
    }
    return {
      ok: false,
      state: failureState,
      feedUrl,
      ...(statusCode ? { statusCode } : {}),
      message: message ?? 'No sources feed is available.',
    }
  }

  private async fetchWithTimeout(url: URL, cache: CacheFile | null, forceRefresh: boolean): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (!forceRefresh && cache?.etag) headers['if-none-match'] = cache.etag
    return this.fetcher(url.toString(), { method: 'GET', headers, signal: controller.signal }).finally(() =>
      clearTimeout(timeout),
    )
  }

  private async readCache(feedUrl: string): Promise<CacheFile | null> {
    try {
      const payload = JSON.parse(await readFile(this.cachePath, 'utf8')) as Partial<CacheFile>
      if (payload.schemaVersion !== 1) return null
      if (payload.feedUrl !== feedUrl) return null
      if (typeof payload.fetchedAt !== 'string' || Number.isNaN(Date.parse(payload.fetchedAt))) return null
      const parsed = parseHostedSourcesFeed(payload.feed)
      if (!parsed.ok) return null
      return {
        schemaVersion: 1,
        feedUrl,
        ...(typeof payload.etag === 'string' && payload.etag ? { etag: payload.etag } : {}),
        fetchedAt: payload.fetchedAt,
        feed: parsed.feed,
      }
    } catch {
      return null
    }
  }

  private async writeCache(cache: CacheFile): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeFile(this.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  }

  private async readSeed(): Promise<HostedSourcesFeed | null> {
    if (!this.packagedSeedPath) return null
    try {
      await stat(this.packagedSeedPath)
      const parsed = parseHostedSourcesFeed(await readFile(this.packagedSeedPath, 'utf8'))
      return parsed.ok ? parsed.feed : null
    } catch {
      return null
    }
  }
}

function parseHttpsUrl(value: string): { ok: true; url: URL } | { ok: false; message: string } {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return { ok: false, message: 'The sources feed URL must use HTTPS.' }
    return { ok: true, url }
  } catch {
    return { ok: false, message: 'The sources feed URL is invalid.' }
  }
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available in this runtime.')
  return globalThis.fetch(url, init)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
