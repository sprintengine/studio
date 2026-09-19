import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'

// The account badge shows the provider profile photo. The account service hands
// the desktop a remote URL (Google `picture`, GitHub `avatar_url`); the
// renderer never loads that URL itself. This cache fetches the bytes once,
// keeps them on disk keyed by the source URL, and hands out a `data:` URL, so:
//   - a boot with a cached photo shows it in the same state publish as the
//     rest of the account (no initials flash while an <img> loads),
//   - an offline boot still shows the photo (the bytes are local),
//   - a broken or slow URL degrades to "no photo" without touching the UI.
// The renderer's fallback to initials stays in place for a null result.

export type AccountPhotoCacheEntry = {
  sourceUrl: string
  dataUrl: string
  fetchedAt: string
}

export type AccountPhotoCacheOptions = {
  /** Lazy: Electron's userData path is only valid once the app is ready. */
  cachePath: () => string
  fetchImpl?: typeof fetch
  now?: () => Date
  /** Largest image accepted; provider avatars are a few KB at `s96`. */
  maxBytes?: number
  /** How long a cached photo is trusted before a refresh is attempted. */
  maxAgeMs?: number
  /** Per-fetch timeout; a stalled CDN must not hold up the account state. */
  timeoutMs?: number
  log?: (event: string, detail: Record<string, unknown>) => void
}

const ACCOUNT_PHOTO_MAX_BYTES = 512 * 1024
const ACCOUNT_PHOTO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ACCOUNT_PHOTO_FETCH_TIMEOUT_MS = 5000

export class AccountPhotoCache {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly maxBytes: number
  private readonly maxAgeMs: number
  private readonly timeoutMs: number
  private readonly log: (event: string, detail: Record<string, unknown>) => void
  private memory: AccountPhotoCacheEntry | null | undefined

  constructor(private readonly options: AccountPhotoCacheOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    this.maxBytes = options.maxBytes ?? ACCOUNT_PHOTO_MAX_BYTES
    this.maxAgeMs = options.maxAgeMs ?? ACCOUNT_PHOTO_MAX_AGE_MS
    this.timeoutMs = options.timeoutMs ?? ACCOUNT_PHOTO_FETCH_TIMEOUT_MS
    this.log = options.log ?? ((event, detail) => console.warn(`[auth] ${event}`, detail))
  }

  /**
   * The renderable `data:` URL for `sourceUrl`, or null. A cached entry for the
   * same source is returned without a network round-trip while it is fresh;
   * a stale one is refreshed when `allowNetwork` permits, and kept when the
   * refresh fails. A different source (the user changed their photo) is
   * fetched, and yields null — never the previous account's photo — when that
   * fails or the network is off-limits.
   */
  async resolve(sourceUrl: string | null, options: { allowNetwork?: boolean } = {}): Promise<string | null> {
    const allowNetwork = options.allowNetwork ?? true
    if (!sourceUrl) return null

    const cached = await this.read()
    const hit = cached?.sourceUrl === sourceUrl ? cached : null
    if (hit && (!allowNetwork || !this.isStale(hit))) {
      return hit.dataUrl
    }
    if (!allowNetwork) return null

    const fetched = await this.fetchDataUrl(sourceUrl)
    if (fetched) {
      const entry: AccountPhotoCacheEntry = { sourceUrl, dataUrl: fetched, fetchedAt: this.now().toISOString() }
      await this.write(entry)
      return fetched
    }
    return hit?.dataUrl ?? null
  }

  /**
   * Whether `resolve` would go to the network for this source: no cached
   * bytes, or bytes past their age. Lets the caller publish what it has now
   * and fetch in the background rather than hold the account state.
   */
  async needsFetch(sourceUrl: string | null): Promise<boolean> {
    if (!sourceUrl) return false
    const cached = await this.read()
    return cached?.sourceUrl !== sourceUrl || this.isStale(cached)
  }

  async clear(): Promise<void> {
    this.memory = null
    await unlink(this.options.cachePath()).catch(() => {})
  }

  private isStale(entry: AccountPhotoCacheEntry): boolean {
    const fetchedAt = Date.parse(entry.fetchedAt)
    return !Number.isFinite(fetchedAt) || this.now().getTime() - fetchedAt > this.maxAgeMs
  }

  private async read(): Promise<AccountPhotoCacheEntry | null> {
    if (this.memory !== undefined) return this.memory
    try {
      const payload = JSON.parse(await readFile(this.options.cachePath(), 'utf8')) as Partial<AccountPhotoCacheEntry>
      this.memory = isCacheEntry(payload) ? payload : null
    } catch {
      this.memory = null
    }
    return this.memory
  }

  private async write(entry: AccountPhotoCacheEntry): Promise<void> {
    this.memory = entry
    try {
      const path = this.options.cachePath()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      // The photo still renders this session; only the next boot pays again.
      this.log('account-photo-cache-write-failed', { message: errorMessage(error) })
    }
  }

  private async fetchDataUrl(sourceUrl: string): Promise<string | null> {
    if (!isHttpsUrl(sourceUrl)) {
      this.log('account-photo-rejected', { reason: 'not-https' })
      return null
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(sourceUrl, {
        method: 'GET',
        headers: { accept: 'image/*' },
        redirect: 'follow',
        signal: controller.signal,
      })
      if (!response.ok) {
        this.log('account-photo-fetch-failed', { status: response.status })
        return null
      }
      // Redirects are followed, so the https guarantee has to hold at the end.
      if (response.url && !isHttpsUrl(response.url)) {
        this.log('account-photo-rejected', { reason: 'redirected-off-https' })
        return null
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') {
        this.log('account-photo-rejected', { reason: 'content-type', contentType })
        return null
      }
      const declared = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > this.maxBytes) {
        this.log('account-photo-rejected', { reason: 'too-large', bytes: declared })
        return null
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength === 0) {
        this.log('account-photo-rejected', { reason: 'empty' })
        return null
      }
      if (bytes.byteLength > this.maxBytes) {
        this.log('account-photo-rejected', { reason: 'too-large', bytes: bytes.byteLength })
        return null
      }
      return `data:${contentType};base64,${bytes.toString('base64')}`
    } catch (error) {
      this.log('account-photo-fetch-failed', { message: errorMessage(error) })
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function isCacheEntry(value: Partial<AccountPhotoCacheEntry>): value is AccountPhotoCacheEntry {
  return (
    typeof value.sourceUrl === 'string' &&
    typeof value.dataUrl === 'string' &&
    value.dataUrl.startsWith('data:image/') &&
    typeof value.fetchedAt === 'string'
  )
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
