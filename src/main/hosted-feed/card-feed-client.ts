// Fetches the hosted card feed (src/shared/hosted-card-feed.ts) the way
// model-feed-client.ts fetches the model feed: HTTPS only, ETag/304, a cache
// file under userData, a bundled seed for the first boot and for offline, and
// honest source/state reporting. Deliberately a sibling and not a shared
// abstraction — the two feeds have different schemas and must be free to drift,
// which is the rule the model-feed client already states about itself. The
// rules are restated here rather than imported for the same reason, and two of
// them are honoured DIFFERENTLY here on purpose; both divergences are marked
// below and say why the card feed cannot afford the model feed's version.
//
// The five rules, as this file honours them
// (backlog/2026-09-06-the-card-feed-is-a-hosted-file.md, item 2465):
//   - the feed URL must be HTTPS, the default and any override alike;
//   - precedence is remote > disk cache > bundled seed, EXCEPT a seed whose
//     `updatedAt` is newer than the cache wins, so a release can correct or
//     retire a card before the next successful fetch. That comparison is on
//     `updatedAt` and never on a file's mtime, which says only when the
//     installer wrote it. A seed that wins is ADOPTED into the cache rather
//     than merely preferred — see `readLocal`;
//   - a fetch is attempted at most once per TTL, and after a failure not again
//     for the retry gap, so an offline machine never pays a timeout on every
//     read — and every failure path re-arms the gap, so a machine that cannot
//     reach GitHub cannot spin;
//   - a body that fails the schema gate is never written to cache. The last
//     good copy stays and the result says why. A body that parses with some
//     rows dropped is a success: one bad card never blanks the home page
//     (epic ruling R6 — the page does not apologise for its own network). What
//     is CACHED is the raw body, not the parsed feed — see `CacheFile`;
//   - the result says where the copy came from and what it lost on the way, so
//     nothing downstream has to guess whether it is looking at the network, the
//     cache or the installer, or why a card it expected is not there.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import type { HostedCardFeedReadInput, HostedCardFeedReadResult } from '../../shared/electron-api'
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

// What is on disk. `body` is the feed EXACTLY as it was received, and never the
// parsed feed — the second divergence from the model feed, and the one that
// matters most over time.
//
// Caching the parsed feed loses a row permanently. `parseHostedCardFeed` drops
// a card whose verb THIS build does not know; if the drop happened before the
// write, the cache would hold the truncated feed, and the very next 304 rewrites
// that truncated feed back with its ETag preserved — so the server, correctly,
// never sends the row again, and the card is gone from that install until
// something else changes the file. An older build downgrading a newer feed is
// exactly the case the drop-and-count rule exists for, and it would have been
// the case that made it permanent. Storing the body and re-parsing on every read
// means dropping a card affects what is SERVED and never what is STORED: install
// the build that knows the verb and the card comes back.
type CacheFile = {
  schemaVersion: 1
  feedUrl: string
  etag?: string
  fetchedAt: string
  body: string
}

// A stored body plus what this build makes of it right now.
type LocalCopy = {
  file: CacheFile
  feed: HostedCardFeed
  dropped: number
  dropReasons: string[]
}

type SeedCopy = {
  body: string
  feed: HostedCardFeed
  dropped: number
  dropReasons: string[]
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

  // Two network reads never overlap: a manual refresh during a scheduled tick
  // joins the tick.
  //
  // A `cachedOnly` read is not one of them, and gets its own path — the first
  // divergence from the model feed. The in-flight guard hands back whatever
  // promise is running regardless of what was asked for, so a `cachedOnly` read
  // issued while a fetch is in flight used to wait out the whole 10s timeout
  // for an answer that was sitting on disk. The model feed can live with that
  // because a background poller reads it and nothing draws on the result; the
  // home page draws on this one, and a page that opens on a spinner because
  // something else was talking to GitHub is the failure this input exists to
  // prevent.
  read(input: HostedCardFeedReadInput = {}): Promise<HostedCardFeedReadResult> {
    if (input.cachedOnly === true) return this.readLocalOnly()
    if (this.inFlight) return this.inFlight
    const run = this.readOnce(input).finally(() => {
      if (this.inFlight === run) this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async readLocalOnly(): Promise<HostedCardFeedReadResult> {
    const feedUrl = this.feedUrl
    const parsedUrl = parseHttpsUrl(feedUrl)
    if (!parsedUrl.ok) {
      return { ok: false, state: 'fetch-error', feedUrl, message: parsedUrl.message }
    }
    const local = await this.readLocal(feedUrl)
    return this.serveLocal(feedUrl, local, undefined)
  }

  private async readOnce(input: HostedCardFeedReadInput): Promise<HostedCardFeedReadResult> {
    const feedUrl = this.feedUrl
    const parsedUrl = parseHttpsUrl(feedUrl)
    if (!parsedUrl.ok) {
      return { ok: false, state: 'fetch-error', feedUrl, message: parsedUrl.message }
    }

    const local = await this.readLocal(feedUrl)
    const { cache } = local

    const nowMs = this.now().getTime()
    const force = input.forceRefresh === true
    if (!force && cache && nowMs - Date.parse(cache.file.fetchedAt) < this.ttlMs) {
      return this.serveLocal(feedUrl, local, undefined)
    }
    if (!force && this.lastFailureAtMs !== null && nowMs - this.lastFailureAtMs < this.retryMs) {
      return this.serveLocal(feedUrl, local, 'Waiting before trying GitHub again.')
    }

    let response: Response
    try {
      response = await this.fetchWithTimeout(parsedUrl.url, cache, force)
    } catch (error) {
      this.lastFailureAtMs = nowMs
      return this.serveLocal(feedUrl, local, `Couldn't reach GitHub. ${formatError(error)}`, 'offline')
    }

    if (response.status === 304) {
      if (!cache) {
        this.lastFailureAtMs = nowMs
        return { ok: false, state: 'fetch-error', feedUrl, statusCode: 304, message: 'GitHub answered 304 Not Modified, but there is no cached copy.' }
      }
      const touched: CacheFile = { ...cache.file, fetchedAt: this.now().toISOString() }
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
        feed: cache.feed,
        ...(cache.dropped > 0 ? { dropped: cache.dropped, dropReasons: cache.dropReasons } : {}),
      }
    }

    if (!response.ok) {
      this.lastFailureAtMs = nowMs
      return this.serveLocal(feedUrl, local, `GitHub answered HTTP ${response.status}.`, 'fetch-error', response.status)
    }

    let body: string
    try {
      body = await response.text()
    } catch (error) {
      this.lastFailureAtMs = nowMs
      return this.serveLocal(feedUrl, local, `The card feed could not be read. ${formatError(error)}`, 'offline')
    }

    const parsed = parseHostedCardFeed(body)
    if (!parsed.ok) {
      // Never cached. The last good copy stands and the line says why.
      this.lastFailureAtMs = nowMs
      return this.serveLocal(feedUrl, local, parsed.message, 'invalid-schema')
    }

    const etag = response.headers.get('etag') ?? undefined
    const fetchedAt = this.now().toISOString()
    // `changed` is "the cards on screen are now different", measured against
    // what the cache held. The first live fetch after install (no cache yet)
    // counts even when its body matches the bundled seed: the page opened on
    // the seed, and this is the read that tells it the live copy is in hand.
    // Compared on the PARSED feeds, so a reformatting of the hosted file that
    // changes no card is not news even though the stored body changed.
    const changed = !cache || JSON.stringify(cache.feed) !== JSON.stringify(parsed.feed)
    // The body as received, which passed the gate a line above. The rows this
    // build dropped are dropped for this read only; the next build to read this
    // file gets them back.
    await this.writeCache({ schemaVersion: 1, feedUrl, ...(etag ? { etag } : {}), fetchedAt, body })
    this.lastFailureAtMs = null
    return {
      ok: true,
      state: 'ok',
      feedUrl,
      source: 'network',
      fetchedAt,
      ...(etag ? { etag } : {}),
      changed,
      ...(parsed.dropped > 0 ? { dropped: parsed.dropped, dropReasons: parsed.dropReasons } : {}),
      feed: parsed.feed,
    }
  }

  // Everything on this machine: the bundled seed, the disk cache, and which of
  // the two the cache now holds.
  //
  // A seed whose `updatedAt` leads the cache is ADOPTED into the cache, not
  // merely preferred for this read. Preferring it alone meant setting `cache`
  // to null, and `cache` is how the TTL gate is spelled (`!force && cache &&
  // …`) — so every read went to the network, ignored the TTL entirely, and
  // reported `changed: true` every time, because `!cache` is the first term of
  // that comparison too. A card seed is authored by hand ahead of publication,
  // so a fresh release is in exactly that state from the day it is cut: the
  // shipped seed leads the hosted file until someone updates the hosted file.
  // Writing the seed through makes the next comparison equal and the TTL apply
  // again. `fetchedAt` is carried over from the cache being replaced — it
  // records when this machine last spoke to GitHub, and adopting a file the
  // installer put there does not change that — and the ETag is dropped, because
  // it identified the body that is no longer stored.
  //
  // The model feed has the same shape and is deliberately NOT changed: its seed
  // is regenerated by `npm run sync:model-feed` from the same hosted file it
  // fetches, so its `updatedAt` never leads the remote, and it is read by a
  // background poller that can afford a wasted round trip. This one is read
  // every time the home page opens.
  private async readLocal(feedUrl: string): Promise<{ cache: LocalCopy | null; seed: SeedCopy | null; fromSeed: boolean }> {
    const seed = await this.readSeed()
    const cache = await this.readCache(feedUrl)
    if (cache && seed && hostedCardFeedUpdatedAtMs(seed.feed) > hostedCardFeedUpdatedAtMs(cache.feed)) {
      return { cache: await this.adoptSeed(feedUrl, seed, cache.file.fetchedAt), seed, fromSeed: true }
    }
    return { cache, seed, fromSeed: false }
  }

  private async adoptSeed(feedUrl: string, seed: SeedCopy, fetchedAt: string): Promise<LocalCopy> {
    const file: CacheFile = { schemaVersion: 1, feedUrl, fetchedAt, body: seed.body }
    // A cache this machine cannot write is not a reason to fall back to the
    // stale copy the seed just outranked: the read goes on with the seed in
    // hand, and the next read tries the write again.
    try {
      await this.writeCache(file)
    } catch {
      // Nothing to say. `serveLocal` reports the copy, not the disk.
    }
    return { file, feed: seed.feed, dropped: seed.dropped, dropReasons: seed.dropReasons }
  }

  // What to show when the network did not answer with a fresh body: the cache,
  // else the seed, else an explicit failure.
  private serveLocal(
    feedUrl: string,
    local: { cache: LocalCopy | null; seed: SeedCopy | null; fromSeed: boolean },
    message: string | undefined,
    failureState: 'offline' | 'fetch-error' | 'invalid-schema' = 'offline',
    statusCode?: number,
  ): HostedCardFeedReadResult {
    const { cache, seed, fromSeed } = local
    if (cache) {
      return {
        ok: true,
        state: message ? 'degraded' : 'ok',
        feedUrl,
        // An adopted seed is on the cache file by now, but what the person is
        // looking at is the copy the installer shipped, and saying 'cache'
        // would hide that.
        source: fromSeed ? 'seed' : 'cache',
        fetchedAt: cache.file.fetchedAt,
        ...(cache.file.etag ? { etag: cache.file.etag } : {}),
        changed: false,
        feed: cache.feed,
        ...(cache.dropped > 0 ? { dropped: cache.dropped, dropReasons: cache.dropReasons } : {}),
        ...(message ? { message } : {}),
      }
    }
    if (seed) {
      return {
        ok: true,
        state: message ? 'degraded' : 'ok',
        feedUrl,
        source: 'seed',
        fetchedAt: seed.feed.updatedAt,
        changed: false,
        feed: seed.feed,
        ...(seed.dropped > 0 ? { dropped: seed.dropped, dropReasons: seed.dropReasons } : {}),
        ...(message ? { message } : {}),
      }
    }
    return { ok: false, state: failureState, feedUrl, ...(statusCode ? { statusCode } : {}), message: message ?? 'No card feed is available.' }
  }

  private async fetchWithTimeout(url: URL, cache: LocalCopy | null, forceRefresh: boolean): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (!forceRefresh && cache?.file.etag) headers['if-none-match'] = cache.file.etag
    return this.fetcher(url.toString(), { method: 'GET', headers, signal: controller.signal }).finally(() => clearTimeout(timeout))
  }

  // Re-parsed on every read, never on the way in: see `CacheFile`.
  private async readCache(feedUrl: string): Promise<LocalCopy | null> {
    try {
      const payload = JSON.parse(await readFile(this.cachePath, 'utf8')) as Partial<CacheFile>
      if (payload.schemaVersion !== 1) return null
      if (payload.feedUrl !== feedUrl) return null
      if (typeof payload.fetchedAt !== 'string' || Number.isNaN(Date.parse(payload.fetchedAt))) return null
      if (typeof payload.body !== 'string') return null
      const parsed = parseHostedCardFeed(payload.body)
      if (!parsed.ok) return null
      const file: CacheFile = {
        schemaVersion: 1,
        feedUrl,
        ...(typeof payload.etag === 'string' && payload.etag ? { etag: payload.etag } : {}),
        fetchedAt: payload.fetchedAt,
        body: payload.body,
      }
      return { file, feed: parsed.feed, dropped: parsed.dropped, dropReasons: parsed.dropReasons }
    } catch {
      return null
    }
  }

  private async writeCache(cache: CacheFile): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeFile(this.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  }

  private async readSeed(): Promise<SeedCopy | null> {
    if (!this.packagedSeedPath) return null
    try {
      await stat(this.packagedSeedPath)
      const body = await readFile(this.packagedSeedPath, 'utf8')
      const parsed = parseHostedCardFeed(body)
      return parsed.ok ? { body, feed: parsed.feed, dropped: parsed.dropped, dropReasons: parsed.dropReasons } : null
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
