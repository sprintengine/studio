// Fetches the hosted card feed (src/shared/hosted-card-feed.ts) the way
// model-feed-client.ts fetches the model feed: HTTPS only, ETag/304, a cache
// file under userData, a bundled seed for the first boot and for offline, and
// honest source/state reporting. Deliberately a sibling and not a shared
// abstraction — the two feeds have different schemas and must be free to drift,
// which is the rule the model-feed client already states about itself. The
// rules are restated here rather than imported for the same reason.
//
// The five rules, as this file honours them
// (backlog/2026-09-06-the-card-feed-is-a-hosted-file.md, item 2465):
//   - the feed URL must be HTTPS, the default and any override alike;
//   - precedence is remote > disk cache > bundled seed, EXCEPT a seed whose
//     `updatedAt` is newer than the cache wins, so a release can correct or
//     retire a card before the next successful fetch. That comparison is on
//     `updatedAt` and never on a file's mtime, which says only when the
//     installer wrote it;
//   - a fetch is attempted at most once per TTL, and after a failure not again
//     for the retry gap, so an offline machine never pays a timeout on every
//     read — and every failure path re-arms the gap, so a machine that cannot
//     reach GitHub cannot spin;
//   - a body that fails the schema gate is never written to cache. The last
//     good copy stays and the result says why. A body that parses with some
//     rows dropped is a success: one bad card never blanks the home page
//     (epic ruling R6 — the page does not apologise for its own network);
//   - the result says where the copy came from, so nothing downstream has to
//     guess whether it is looking at the network, the cache or the installer.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import {
  HOSTED_CARD_FEED_URL,
  hostedCardFeedUpdatedAtMs,
  parseHostedCardFeed,
  type HostedCardFeed,
} from '../../shared/hosted-card-feed'

export const CARD_FEED_CACHE_FILENAME = 'card-feed-cache.json'
export const CARD_FEED_SEED_FILENAME = 'cards-feed.json'
export const DEFAULT_CARD_FEED_TIMEOUT_MS = 10_000
// One fetch an hour, and one retry every five minutes after a failure.
export const CARD_FEED_TTL_MS = 60 * 60 * 1_000
export const CARD_FEED_RETRY_MS = 5 * 60 * 1_000

// The read contract, which item 2466 lifts into src/shared/electron-api.ts when
// the IPC pair and the preload surface land. It lives here until then so this
// item ships nothing that pretends to be a channel it has not wired.
export type HostedCardFeedReadInput = {
  forceRefresh?: boolean
  // Serve whatever is on disk (cache, else seed) without touching the network.
  // The home page uses it so it never waits on a fetch to draw.
  cachedOnly?: boolean
}

export type HostedCardFeedReadResult =
  | {
      ok: true
      state: 'ok' | 'degraded'
      feedUrl: string
      source: 'network' | 'cache' | 'seed'
      fetchedAt: string
      etag?: string
      notModified?: boolean
      // True when this read wrote a different copy to the disk cache (the first
      // live copy after install counts, even if it equals the bundled seed).
      changed: boolean
      feed: HostedCardFeed
      // Rows the schema gate refused inside an otherwise good body. Reported,
      // never fatal.
      dropped?: number
      message?: string
    }
  | {
      ok: false
      state: 'offline' | 'fetch-error' | 'invalid-schema'
      feedUrl: string
      statusCode?: number
      message: string
    }

// MULTICODE_CARD_FEED_URL points the client at another copy of the file — a
// local static server while developing, a fork's raw URL — with every other
// rule (ETag, cache, seed, schema gate) unchanged. HTTPS only, like the
// default: the override is checked by the same `parseHttpsUrl` on every read,
// so there is no way in through the environment that the default does not have.
export function configuredCardFeedUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MULTICODE_CARD_FEED_URL?.trim()
  return override || HOSTED_CARD_FEED_URL
}

export function defaultCardFeedCachePath(userDataDir: string): string {
  return join(userDataDir, CARD_FEED_CACHE_FILENAME)
}

// Where the bundled seed lives: `resources/cards-feed.json` in a checkout,
// copied to the resources root by build.extraResources in a packaged app.
export function cardFeedSeedCandidates(options: {
  isPackaged: boolean
  resourcesPath?: string
  appPath?: string | null
  cwd?: string
}): string[] {
  const candidates: string[] = []
  if (options.isPackaged) {
    if (options.resourcesPath) candidates.push(join(options.resourcesPath, CARD_FEED_SEED_FILENAME))
    if (options.appPath) candidates.push(join(options.appPath, 'resources', CARD_FEED_SEED_FILENAME))
    return candidates
  }
  if (options.cwd) candidates.push(join(options.cwd, 'resources', CARD_FEED_SEED_FILENAME))
  if (options.appPath) candidates.push(join(options.appPath, 'resources', CARD_FEED_SEED_FILENAME))
  return candidates.filter((candidate) => isAbsolute(candidate))
}

export type CardFeedFetch = (url: string, init: RequestInit) => Promise<Response>

export type HostedCardFeedClientOptions = {
  feedUrl?: string
  cachePath: string
  fetcher?: CardFeedFetch
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
  feed: HostedCardFeed
}

export class HostedCardFeedClient {
  private readonly feedUrl: string
  private readonly cachePath: string
  private readonly fetcher: CardFeedFetch
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly packagedSeedPath: string | null
  private readonly ttlMs: number
  private readonly retryMs: number
  private lastFailureAtMs: number | null = null
  private inFlight: Promise<HostedCardFeedReadResult> | null = null

  constructor(options: HostedCardFeedClientOptions) {
    this.feedUrl = (options.feedUrl ?? configuredCardFeedUrl()).trim()
    this.cachePath = options.cachePath
    this.fetcher = options.fetcher ?? defaultFetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CARD_FEED_TIMEOUT_MS
    this.now = options.now ?? (() => new Date())
    this.packagedSeedPath = options.packagedSeedPath ?? null
    this.ttlMs = options.ttlMs ?? CARD_FEED_TTL_MS
    this.retryMs = options.retryMs ?? CARD_FEED_RETRY_MS
  }

  // Never overlaps: a manual refresh during a scheduled tick joins the tick.
  read(input: HostedCardFeedReadInput = {}): Promise<HostedCardFeedReadResult> {
    if (this.inFlight) return this.inFlight
    const run = this.readOnce(input).finally(() => {
      if (this.inFlight === run) this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async readOnce(input: HostedCardFeedReadInput): Promise<HostedCardFeedReadResult> {
    const feedUrl = this.feedUrl
    const parsedUrl = parseHttpsUrl(feedUrl)
    if (!parsedUrl.ok) {
      return { ok: false, state: 'fetch-error', feedUrl, message: parsedUrl.message }
    }

    const seed = await this.readSeed()
    let cache = await this.readCache(feedUrl)
    // The bundled seed is the release's own data. A cache written before that
    // release carries older edits, and must not outrank it. Compared on
    // `updatedAt` — when the file was edited — never on when it landed on disk.
    if (cache && seed && hostedCardFeedUpdatedAtMs(seed) > hostedCardFeedUpdatedAtMs(cache.feed)) cache = null

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
        return { ok: false, state: 'fetch-error', feedUrl, statusCode: 304, message: 'GitHub answered 304 Not Modified, but there is no cached copy.' }
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
      return this.serveLocal(feedUrl, cache, seed, `GitHub answered HTTP ${response.status}.`, 'fetch-error', response.status)
    }

    let body: string
    try {
      body = await response.text()
    } catch (error) {
      this.lastFailureAtMs = nowMs
      return this.serveLocal(feedUrl, cache, seed, `The card feed could not be read. ${formatError(error)}`, 'offline')
    }

    const parsed = parseHostedCardFeed(body)
    if (!parsed.ok) {
      // Never cached. The last good copy stands and the line says why.
      this.lastFailureAtMs = nowMs
      return this.serveLocal(feedUrl, cache, seed, parsed.message, 'invalid-schema')
    }

    const etag = response.headers.get('etag') ?? undefined
    const fetchedAt = this.now().toISOString()
    // `changed` is "the cache on disk is now different", measured against the
    // cache alone. The first live fetch after install (no cache yet) counts even
    // when its body matches the bundled seed: the page opened on the seed, and
    // this is the read that tells it the live copy is in hand.
    const changed = !cache || JSON.stringify(cache.feed) !== JSON.stringify(parsed.feed)
    // What is cached is the parsed feed, not the body: the dropped rows are
    // dropped once, here, and never revive from disk on the next read.
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
      ...(parsed.dropped > 0 ? { dropped: parsed.dropped } : {}),
      feed: parsed.feed,
    }
  }

  // What to show when the network did not answer with a fresh body: the cache,
  // else the seed, else an explicit failure.
  private serveLocal(
    feedUrl: string,
    cache: CacheFile | null,
    seed: HostedCardFeed | null,
    message: string | undefined,
    failureState: 'offline' | 'fetch-error' | 'invalid-schema' = 'offline',
    statusCode?: number,
  ): HostedCardFeedReadResult {
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
    return { ok: false, state: failureState, feedUrl, ...(statusCode ? { statusCode } : {}), message: message ?? 'No card feed is available.' }
  }

  private async fetchWithTimeout(url: URL, cache: CacheFile | null, forceRefresh: boolean): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (!forceRefresh && cache?.etag) headers['if-none-match'] = cache.etag
    return this.fetcher(url.toString(), { method: 'GET', headers, signal: controller.signal }).finally(() => clearTimeout(timeout))
  }

  private async readCache(feedUrl: string): Promise<CacheFile | null> {
    try {
      const payload = JSON.parse(await readFile(this.cachePath, 'utf8')) as Partial<CacheFile>
      if (payload.schemaVersion !== 1) return null
      if (payload.feedUrl !== feedUrl) return null
      if (typeof payload.fetchedAt !== 'string' || Number.isNaN(Date.parse(payload.fetchedAt))) return null
      const parsed = parseHostedCardFeed(payload.feed)
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

  private async readSeed(): Promise<HostedCardFeed | null> {
    if (!this.packagedSeedPath) return null
    try {
      await stat(this.packagedSeedPath)
      const parsed = parseHostedCardFeed(await readFile(this.packagedSeedPath, 'utf8'))
      return parsed.ok ? parsed.feed : null
    } catch {
      return null
    }
  }
}

function parseHttpsUrl(value: string): { ok: true; url: URL } | { ok: false; message: string } {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return { ok: false, message: 'The card feed URL must use HTTPS.' }
    return { ok: true, url }
  } catch {
    return { ok: false, message: 'The card feed URL is invalid.' }
  }
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available in this runtime.')
  return globalThis.fetch(url, init)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
