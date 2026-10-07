import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isRecord } from '../../shared/records'
import {
  claudeUsageWindowScope,
  USAGE_LIMIT_PROVIDERS,
  type UsageLimitProvider,
  type UsageLimitSnapshot,
  type UsageLimitStatus,
  type UsageLimitWindow,
} from '../../shared/usage-limits'
import { writeFileAtomically } from '../config-file-write'
import type { UsageLimitsStore } from './store'

// The last usage-limit reading per provider, kept across restarts so the bars
// are there at launch rather than after the first turn — drawn "as of" when
// they were read, since nothing has confirmed them since. A cache and nothing
// more: a missing, unreadable or malformed file is an empty one.

export const USAGE_LIMITS_CACHE_FILE = 'usage-limits-cache.json'
const WRITE_DEBOUNCE_MS = 2_000
const FORMAT_VERSION = 1
// A provider reports a handful of windows; more is a file edited by hand.
const MAX_WINDOWS = 16
const MAX_TEXT_LENGTH = 120

const STATUSES = new Set<UsageLimitStatus>(['allowed', 'warning', 'rejected'])

export type UsageLimitsDiskCache = {
  /** Read the file into the store, then keep the file current with it. */
  attach(store: UsageLimitsStore): Promise<void>
  /** Write any pending change now; for quit and tests. */
  flush(): Promise<void>
  /** Stop following the store, writing what is pending. */
  dispose(): Promise<void>
}

export function createUsageLimitsDiskCache(options: { file: string; debounceMs?: number }): UsageLimitsDiskCache {
  const debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS
  let store: UsageLimitsStore | null = null
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()

  async function write(): Promise<void> {
    if (!store) return
    const body = JSON.stringify({ version: FORMAT_VERSION, snapshots: store.persisted() })
    try {
      await mkdir(dirname(options.file), { recursive: true })
      await writeFileAtomically(options.file, body)
    } catch {
      // A cache that cannot be written costs the bars until the first turn.
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      writing = writing.then(write)
    }, debounceMs)
    timer.unref?.()
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
      writing = writing.then(write)
    }
    await writing
  }

  return {
    async attach(target) {
      store = target
      target.restore(await readUsageLimitsCache(options.file))
      unsubscribe = target.onChanged(schedule)
    },
    flush,
    async dispose() {
      unsubscribe?.()
      unsubscribe = null
      await flush()
    },
  }
}

export async function readUsageLimitsCache(file: string): Promise<UsageLimitSnapshot[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.snapshots)) return []
  const snapshots: UsageLimitSnapshot[] = []
  for (const raw of parsed.snapshots) {
    const snapshot = readSnapshot(raw)
    if (snapshot && !snapshots.some((known) => known.provider === snapshot.provider)) snapshots.push(snapshot)
  }
  return snapshots
}

function readSnapshot(raw: unknown): UsageLimitSnapshot | null {
  if (!isRecord(raw) || !USAGE_LIMIT_PROVIDERS.includes(raw.provider as UsageLimitProvider)) return null
  // Only a subscription's reading is ever written.
  if (raw.billing !== 'subscription' || !Array.isArray(raw.windows) || !time(raw.observedAt)) return null
  const windows = raw.windows.slice(0, MAX_WINDOWS).flatMap((entry) => {
    const window = readWindow(entry)
    return window ? [window] : []
  })
  if (windows.length === 0) return null
  return {
    provider: raw.provider as UsageLimitProvider,
    billing: 'subscription',
    ...(text(raw.plan) ? { plan: raw.plan } : {}),
    windows,
    observedAt: raw.observedAt,
  }
}

function readWindow(raw: unknown): UsageLimitWindow | null {
  if (!isRecord(raw) || !text(raw.id) || !text(raw.label) || !time(raw.observedAt)) return null
  if (!STATUSES.has(raw.status as UsageLimitStatus)) return null
  const usedPercent =
    typeof raw.usedPercent === 'number' && raw.usedPercent >= 0 && raw.usedPercent <= 100 ? raw.usedPercent : null
  const resetsAt = time(raw.resetsAt) ? raw.resetsAt : null
  return {
    id: raw.id,
    label: raw.label,
    usedPercent,
    resetsAt,
    ...(time(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
    ...(raw.scope === 'model' || metersOneModel(raw.id) ? { scope: 'model' as const } : {}),
    status: raw.status as UsageLimitStatus,
    observedAt: raw.observedAt,
  }
}

// A window a cache from before `scope` kept: Claude's model weeklies by their
// id, and a Codex bucket under a limit id of its own.
function metersOneModel(id: string): boolean {
  if (claudeUsageWindowScope(id) === 'model') return true
  return /^[^:]+:(?:primary|secondary)$/u.test(id) && !id.startsWith('codex:')
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
