import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import {
  DEFAULT_TRACKER_WRITEBACK_CONFIG,
  normalizeTrackerWriteBackConfig,
  trackerWriteBackConfigIsActive,
  type TrackerWriteBackConfig,
} from '../../../shared/tracker/writeback'

// Persists per-connection write-back config (MC-1640 / plan §3.7) as one JSON
// file under userData, keyed by connection id. Carries NO secret — only the
// booleans and named transition ids from the schema. Mirrors the connection
// store's own-JSON-file convention (no shared settings store, no electron-store)
// with the module-enablement atomic write (tmp → rename) so a crash mid-write
// never leaves a half-written config. Owned here (T10), read by the engine and —
// via the T11 IPC surface — by the settings UI.

type PersistedWriteBackConfig = { version: 1; byConnection: Record<string, TrackerWriteBackConfig> }

type FileAdapter = {
  mkdir: typeof mkdir
  readFile: typeof readFile
  writeFile: typeof writeFile
  rename: typeof rename
}

export type TrackerWriteBackConfigStoreOptions = {
  resolveUserDataDir?: () => string
  files?: FileAdapter
}

const FILE_NAME = 'tracker-writeback-config.json'

export class TrackerWriteBackConfigStore {
  private readonly resolveUserDataDir: () => string
  private readonly files: FileAdapter
  private byConnection: Record<string, TrackerWriteBackConfig> | null = null

  constructor(options: TrackerWriteBackConfigStoreOptions = {}) {
    this.resolveUserDataDir = options.resolveUserDataDir ?? (() => loadElectron().app.getPath('userData'))
    this.files = options.files ?? { mkdir, readFile, writeFile, rename }
  }

  // The effective config for a connection: its stored value normalized, or the
  // opt-in default when it has none. Always returns a complete, safe config.
  async get(connectionId: string): Promise<TrackerWriteBackConfig> {
    const map = await this.ensureLoaded()
    const stored = map[connectionId]
    return stored ? normalizeTrackerWriteBackConfig(stored) : { ...DEFAULT_TRACKER_WRITEBACK_CONFIG }
  }

  // The full per-connection map (for the T11 settings surface). Normalized copies.
  async list(): Promise<Record<string, TrackerWriteBackConfig>> {
    const map = await this.ensureLoaded()
    const out: Record<string, TrackerWriteBackConfig> = {}
    for (const [id, config] of Object.entries(map)) out[id] = normalizeTrackerWriteBackConfig(config)
    return out
  }

  async set(connectionId: string, config: TrackerWriteBackConfig): Promise<void> {
    const map = await this.ensureLoaded()
    map[connectionId] = normalizeTrackerWriteBackConfig(config)
    await this.persist(map)
  }

  // Drop a connection's config when the connection is removed, so a re-used id
  // never inherits a prior connection's write-back settings.
  async remove(connectionId: string): Promise<void> {
    const map = await this.ensureLoaded()
    if (!(connectionId in map)) return
    delete map[connectionId]
    await this.persist(map)
  }

  // Cheap engine gate: does ANY connection have active write-back? Lets the
  // engine skip the backlog scan entirely when write-back is off everywhere,
  // preserving zero-connection byte-identical behavior.
  async anyActive(): Promise<boolean> {
    const map = await this.ensureLoaded()
    return Object.values(map).some((config) => trackerWriteBackConfigIsActive(normalizeTrackerWriteBackConfig(config)))
  }

  private async ensureLoaded(): Promise<Record<string, TrackerWriteBackConfig>> {
    if (this.byConnection) return this.byConnection
    this.byConnection = await this.read()
    return this.byConnection
  }

  private async read(): Promise<Record<string, TrackerWriteBackConfig>> {
    let raw: string
    try {
      raw = (await this.files.readFile(this.storePath(), 'utf8')) as string
    } catch {
      return {} // No file yet ⇒ no config ⇒ byte-identical to today.
    }
    try {
      const parsed = JSON.parse(raw) as PersistedWriteBackConfig
      if (!parsed || typeof parsed.byConnection !== 'object' || parsed.byConnection === null) return {}
      const out: Record<string, TrackerWriteBackConfig> = {}
      for (const [id, config] of Object.entries(parsed.byConnection)) {
        out[id] = normalizeTrackerWriteBackConfig(config)
      }
      return out
    } catch {
      return {}
    }
  }

  private async persist(map: Record<string, TrackerWriteBackConfig>): Promise<void> {
    const payload: PersistedWriteBackConfig = { version: 1, byConnection: map }
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

function loadElectron(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}

// Process-wide config-store singleton. The write-back engine (via
// createTrackerWriteBackRuntime) and the T11 IPC surface MUST share ONE instance:
// the store caches `byConnection` in memory, so a save through a second instance
// would leave the engine reconciling against a stale cache until restart. Tests
// that inject `resolveUserDataDir` construct their own isolated instance instead.
let sharedConfigStore: TrackerWriteBackConfigStore | null = null

export function getSharedTrackerWriteBackConfigStore(): TrackerWriteBackConfigStore {
  return (sharedConfigStore ??= new TrackerWriteBackConfigStore())
}
