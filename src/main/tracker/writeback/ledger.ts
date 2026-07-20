import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import type { TrackerProviderId } from '../../../shared/tracker/types'
import type { TrackerWriteBackNotice, TrackerWriteBackPostKind } from '../../../shared/tracker/writeback'

// The idempotency + failure ledger (MC-1640 / plan §3.7). One JSON file under
// userData keyed by the deterministic post key (run id + event + external id).
// Two jobs, one store:
//   - Idempotency: a `posted` entry means that exact post already succeeded, so a
//     projection replay or an app restart mid-run NEVER double-posts.
//   - Notices: a `failed` entry is the visible-on-the-item warning the T11
//     surface renders; a later success overwrites it (the post is no longer
//     failing) so the notice self-clears.
// Persisted with the atomic tmp → rename write, and writes are serialized through
// an in-memory tail promise so two runs reconciling at once never lose an update.

type LedgerEntry = {
  status: 'posted' | 'failed'
  connectionId: string
  externalId: string
  provider: TrackerProviderId
  postKind: TrackerWriteBackPostKind
  relativePath: string
  at: string
  // Present only on a failed entry: the provider's own redacted message.
  message?: string
}

type PersistedLedger = { version: 1; entries: Record<string, LedgerEntry> }

type FileAdapter = {
  mkdir: typeof mkdir
  readFile: typeof readFile
  writeFile: typeof writeFile
  rename: typeof rename
}

export type TrackerWriteBackLedgerOptions = {
  resolveUserDataDir?: () => string
  files?: FileAdapter
}

export type LedgerPostMeta = {
  key: string
  connectionId: string
  externalId: string
  provider: TrackerProviderId
  postKind: TrackerWriteBackPostKind
  relativePath: string
  at: string
  message?: string
}

const FILE_NAME = 'tracker-writeback-ledger.json'

export class TrackerWriteBackLedger {
  private readonly resolveUserDataDir: () => string
  private readonly files: FileAdapter
  private entries: Record<string, LedgerEntry> | null = null
  private writeTail: Promise<void> = Promise.resolve()

  constructor(options: TrackerWriteBackLedgerOptions = {}) {
    this.resolveUserDataDir = options.resolveUserDataDir ?? (() => loadElectron().app.getPath('userData'))
    this.files = options.files ?? { mkdir, readFile, writeFile, rename }
  }

  // True only when this exact post already succeeded. A prior FAILED attempt is
  // NOT posted — so a failure retries on the next real event, per the contract.
  async hasPosted(key: string): Promise<boolean> {
    const entries = await this.ensureLoaded()
    return entries[key]?.status === 'posted'
  }

  async markPosted(meta: LedgerPostMeta): Promise<void> {
    await this.mutate((entries) => {
      entries[meta.key] = {
        status: 'posted',
        connectionId: meta.connectionId,
        externalId: meta.externalId,
        provider: meta.provider,
        postKind: meta.postKind,
        relativePath: meta.relativePath,
        at: meta.at,
      }
    })
  }

  async recordFailure(meta: LedgerPostMeta): Promise<void> {
    await this.mutate((entries) => {
      // Never downgrade a succeeded post to failed — a stale retry that races a
      // success must not resurrect the notice.
      if (entries[meta.key]?.status === 'posted') return
      entries[meta.key] = {
        status: 'failed',
        connectionId: meta.connectionId,
        externalId: meta.externalId,
        provider: meta.provider,
        postKind: meta.postKind,
        relativePath: meta.relativePath,
        at: meta.at,
        message: meta.message ?? 'Write-back post failed.',
      }
    })
  }

  // Every currently-failing post, for the T11 visible-notice surface. A post that
  // later succeeded is a `posted` entry and never appears here.
  async listNotices(): Promise<TrackerWriteBackNotice[]> {
    const entries = await this.ensureLoaded()
    const notices: TrackerWriteBackNotice[] = []
    for (const entry of Object.values(entries)) {
      if (entry.status !== 'failed') continue
      notices.push({
        connectionId: entry.connectionId,
        externalId: entry.externalId,
        provider: entry.provider,
        postKind: entry.postKind,
        relativePath: entry.relativePath,
        message: entry.message ?? 'Write-back post failed.',
        at: entry.at,
      })
    }
    return notices
  }

  private async mutate(apply: (entries: Record<string, LedgerEntry>) => void): Promise<void> {
    const run = this.writeTail.then(async () => {
      const entries = await this.ensureLoaded()
      apply(entries)
      await this.persist(entries)
    })
    // Keep the tail alive even if this write throws, so a later write still runs.
    this.writeTail = run.catch(() => undefined)
    return run
  }

  private async ensureLoaded(): Promise<Record<string, LedgerEntry>> {
    if (this.entries) return this.entries
    this.entries = await this.read()
    return this.entries
  }

  private async read(): Promise<Record<string, LedgerEntry>> {
    let raw: string
    try {
      raw = (await this.files.readFile(this.storePath(), 'utf8')) as string
    } catch {
      return {}
    }
    try {
      const parsed = JSON.parse(raw) as PersistedLedger
      if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null) return {}
      const out: Record<string, LedgerEntry> = {}
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (isLedgerEntry(entry)) out[key] = entry
      }
      return out
    } catch {
      return {}
    }
  }

  private async persist(entries: Record<string, LedgerEntry>): Promise<void> {
    const payload: PersistedLedger = { version: 1, entries }
    const path = this.storePath()
    const tmp = `${path}.tmp`
    await this.files.mkdir(dirname(path), { recursive: true })
    await this.files.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await this.files.rename(tmp, path)
  }

  private storePath(): string {
    return join(this.resolveUserDataDir(), FILE_NAME)
  }
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    (entry.status === 'posted' || entry.status === 'failed') &&
    typeof entry.connectionId === 'string' &&
    typeof entry.externalId === 'string' &&
    typeof entry.postKind === 'string' &&
    typeof entry.relativePath === 'string' &&
    typeof entry.at === 'string'
  )
}

function loadElectron(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}
