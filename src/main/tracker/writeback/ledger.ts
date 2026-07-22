import { access, mkdir, readFile, rename, writeFile } from 'fs/promises'
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
//
// On load the ledger evicts dead weight so it never grows without bound: an entry
// whose run's state file is gone can never be reconciled again, so it is dropped;
// a legacy entry with no recorded run path (or one whose file check is skipped)
// ages out past a generous horizon. An entry for a run that is still on disk is
// KEPT even after the run settles — that is exactly what preserves idempotency if
// a late reconcile re-wakes it.

// Entries older than this with no live run path are pruned on load. Generous so a
// long-running or paused run never loses its posted-record while still on disk.
const LEDGER_RETENTION_MS = 60 * 24 * 60 * 60 * 1000

type LedgerEntry = {
  status: 'posted' | 'failed'
  connectionId: string
  externalId: string
  provider: TrackerProviderId
  postKind: TrackerWriteBackPostKind
  relativePath: string
  at: string
  // The run's state path (run.yaml), used to evict the entry once its run is
  // deleted. Optional so entries written before this field still load.
  statePath?: string
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
  // Clock + run-liveness probe for load-time eviction; injected in tests.
  now?: () => Date
  runStateExists?: (statePath: string) => Promise<boolean>
}

export type LedgerPostMeta = {
  key: string
  statePath: string
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
  private readonly now: () => Date
  private readonly runStateExists: (statePath: string) => Promise<boolean>
  private entries: Record<string, LedgerEntry> | null = null
  private writeTail: Promise<void> = Promise.resolve()

  constructor(options: TrackerWriteBackLedgerOptions = {}) {
    this.resolveUserDataDir = options.resolveUserDataDir ?? (() => loadElectron().app.getPath('userData'))
    this.files = options.files ?? { mkdir, readFile, writeFile, rename }
    this.now = options.now ?? (() => new Date())
    this.runStateExists = options.runStateExists ?? defaultRunStateExists
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
        statePath: meta.statePath,
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
        statePath: meta.statePath,
        message: meta.message ?? 'Write-back post failed.',
      }
    })
  }

  // Drop every entry tied to a connection, so removing a tracker connection also
  // clears its lingering failure notices and posted records (they can never apply
  // again once the connection is gone).
  async dropConnection(connectionId: string): Promise<void> {
    await this.mutate((entries) => {
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.connectionId === connectionId) delete entries[key]
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
    let loaded: Record<string, LedgerEntry>
    try {
      const parsed = JSON.parse(raw) as PersistedLedger
      if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null) return {}
      loaded = {}
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (isLedgerEntry(entry)) loaded[key] = entry
      }
    } catch {
      return {}
    }

    const { kept, evicted } = await this.evictStale(loaded)
    if (evicted > 0) {
      // Shrink the file to what survived. Best-effort: a failed write just means
      // the same entries are re-pruned on the next load.
      await this.persist(kept).catch(() => undefined)
    }
    return kept
  }

  // Drop entries that can never be reconciled again: a run whose state file is
  // gone (the common leak — every deleted run's entries), and legacy entries with
  // no recorded run path once they age past the horizon. An entry whose run is
  // still on disk is KEPT even after the run settles, preserving idempotency.
  private async evictStale(
    entries: Record<string, LedgerEntry>,
  ): Promise<{ kept: Record<string, LedgerEntry>; evicted: number }> {
    const horizon = this.now().getTime() - LEDGER_RETENTION_MS
    const existenceByPath = new Map<string, boolean>()
    const kept: Record<string, LedgerEntry> = {}
    let evicted = 0
    for (const [key, entry] of Object.entries(entries)) {
      if (await this.isEvictable(entry, horizon, existenceByPath)) {
        evicted += 1
        continue
      }
      kept[key] = entry
    }
    return { kept, evicted }
  }

  private async isEvictable(
    entry: LedgerEntry,
    horizon: number,
    existenceByPath: Map<string, boolean>,
  ): Promise<boolean> {
    if (entry.statePath) {
      let exists = existenceByPath.get(entry.statePath)
      if (exists === undefined) {
        exists = await this.runStateExists(entry.statePath)
        existenceByPath.set(entry.statePath, exists)
      }
      return !exists
    }
    const at = Date.parse(entry.at)
    return Number.isFinite(at) && at < horizon
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
    typeof entry.at === 'string' &&
    (entry.statePath === undefined || typeof entry.statePath === 'string')
  )
}

async function defaultRunStateExists(statePath: string): Promise<boolean> {
  try {
    await access(statePath)
    return true
  } catch {
    return false
  }
}

function loadElectron(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}

// Process-wide ledger singleton. The write-back engine (via
// createTrackerWriteBackRuntime) and the connection-removal cleanup in
// TrackerService MUST share ONE instance so a drop is not lost against the
// engine's in-memory cache — the same shared-instance rule the config store
// carries. Tests that inject `resolveUserDataDir` construct their own instance.
let sharedLedger: TrackerWriteBackLedger | null = null

export function getSharedTrackerWriteBackLedger(): TrackerWriteBackLedger {
  return (sharedLedger ??= new TrackerWriteBackLedger())
}
