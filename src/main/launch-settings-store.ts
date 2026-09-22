/**
 * Main's store for the agent-launch settings, and their single owner (shapes
 * and record math in `src/shared/launch-settings.ts`).
 *
 * Main holds the one authoritative record and persists it under userData.
 * Everything that composes a launch reads it **synchronously** through `get()`
 * — the main scheduler, boot-time run discovery, a mobile launch, the model
 * discovery pass main starts itself — so a launch uses the user's real CLI,
 * permission preset and MCP servers with zero windows open, across a restart.
 *
 * Windows do not author these settings any more; they hold a read model of this
 * record. A window reads it at boot (`getSnapshot`), writes to it through
 * partial patches (`update`) and follows every change through `subscribe`,
 * which the IPC layer turns into one broadcast to every window. A setting a
 * person changes in one window is therefore in every other window, and in the
 * next headless launch, without either of them pushing a copy.
 *
 * `migrate` is the one-time handover from the era when windows authored these
 * settings in localStorage: it is accepted only while no record exists, so the
 * first window to offer its values after the upgrade seeds the record and
 * every later offer — a second window, the same window next boot — is refused.
 *
 * Writes are atomic (tmp + rename), serialized behind one another, and carry a
 * monotonic revision plus write provenance; an update that changes nothing is
 * an idempotent no-op (no bump, no write, no broadcast).
 *
 * The file keeps its original name, `agent-launch-settings.json`, so every
 * existing profile keeps its record across this change.
 */
import { readFileSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  agentLaunchSettingsEqual,
  applyAgentLaunchSettingsPatch,
  emptyAgentLaunchSettings,
  nextAgentLaunchSettingsRecord,
  normalizeAgentLaunchSettings,
  normalizeAgentLaunchSettingsPatch,
  parseAgentLaunchSettingsRecord,
  serializeAgentLaunchSettingsRecord,
  type AgentLaunchSettings,
  type AgentLaunchSettingsActor,
  type AgentLaunchSettingsRecord,
  type AgentLaunchSettingsSnapshot,
} from '../shared/launch-settings'

const FILE_NAME = 'agent-launch-settings.json'

export type AgentLaunchSettingsStoreDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
  now?: () => number
}

export type AgentLaunchSettingsWriteResult = {
  record: AgentLaunchSettingsRecord
  /** False for an idempotent no-op: an update that changed nothing, or a refused migration. */
  changed: boolean
  /** Resolves when the atomic write has settled (or failed soft). */
  persisted: Promise<void>
}

export type AgentLaunchSettingsStore = ReturnType<typeof createAgentLaunchSettingsStore>

export function createAgentLaunchSettingsStore(deps: AgentLaunchSettingsStoreDeps) {
  const now = deps.now ?? (() => Date.now())
  let current: AgentLaunchSettingsRecord | null = null
  // The original file held bare settings with no revision. It is readable
  // but not authoritative: reads use it so the first boot after upgrade still
  // spawns with the user's runtimes, the first update is applied on top of it,
  // and a migration offer replaces it with a real record.
  let legacySettings: AgentLaunchSettings | null = null
  let loadedFromDisk = false
  const listeners = new Set<(record: AgentLaunchSettingsRecord) => void>()

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  /**
   * Synchronous read-through of the persisted record. Null means no
   * authoritative record exists yet (absent, corrupt, or the legacy bare
   * settings file), which is the only state a migration is accepted in.
   */
  function loadOnce(): AgentLaunchSettingsRecord | null {
    if (loadedFromDisk) return current
    loadedFromDisk = true
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
      current = parseAgentLaunchSettingsRecord(raw)
      if (!current && raw && typeof raw === 'object' && !Array.isArray(raw)) {
        legacySettings = normalizeAgentLaunchSettings(raw)
      }
    } catch {
      current = null
    }
    return current
  }

  function read(): AgentLaunchSettings {
    return loadOnce()?.settings ?? legacySettings ?? emptyAgentLaunchSettings()
  }

  // Writes serialize behind one another and each gets its own temp file: two
  // writes in the same tick would otherwise race on a shared temp path and
  // could land the older revision last.
  let writeQueue: Promise<void> = Promise.resolve()
  let writeSequence = 0

  function persist(record: AgentLaunchSettingsRecord): Promise<void> {
    const attempt = ++writeSequence
    const settled = writeQueue.then(async () => {
      const target = filePath()
      const tmp = `${target}.tmp-${process.pid}-${attempt}`
      try {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(tmp, serializeAgentLaunchSettingsRecord(record), 'utf8')
        await rename(tmp, target)
      } catch (error) {
        await unlink(tmp).catch(() => undefined)
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Agent launch settings not persisted',
          message:
            'The launch settings could not be written to disk; in-memory values still apply until the app restarts.',
          details: error instanceof Error ? error.message : String(error),
        })
      }
    })
    writeQueue = settled
    return settled
  }

  function commit(settings: AgentLaunchSettings, actor: AgentLaunchSettingsActor): AgentLaunchSettingsWriteResult {
    const record = nextAgentLaunchSettingsRecord({
      current: loadOnce(),
      settings,
      actor,
      now: now(),
    })
    current = record
    legacySettings = null
    const persisted = persist(record)
    for (const listener of listeners) {
      try {
        listener(record)
      } catch {
        // A failing subscriber must not fail the write it is being told about.
      }
    }
    return { record, changed: true, persisted }
  }

  return {
    /** The settings main spawns with. Never throws: an absent store reads as defaults. */
    get(): AgentLaunchSettings {
      return read()
    },

    /** The authoritative record, or null when nothing has been written yet. */
    getRecord(): AgentLaunchSettingsRecord | null {
      return loadOnce()
    },

    /** What a window reads at boot: the record, and the settings in force either way. */
    getSnapshot(): AgentLaunchSettingsSnapshot {
      return { record: loadOnce(), settings: read() }
    },

    /**
     * Apply a partial write (see `AgentLaunchSettingsPatch`). The patch is
     * normalized fail-soft and applied to the settings in force, so the first
     * update onto a legacy bare file carries the rest of that file forward. An
     * update that changes nothing is a no-op: no revision bump, no write, no
     * broadcast.
     */
    update(rawPatch: unknown, actor: AgentLaunchSettingsActor): AgentLaunchSettingsWriteResult {
      const patch = normalizeAgentLaunchSettingsPatch(rawPatch)
      const existing = loadOnce()
      const next = applyAgentLaunchSettingsPatch(read(), patch)
      if (existing && agentLaunchSettingsEqual(existing.settings, next)) {
        return { record: existing, changed: false, persisted: Promise.resolve() }
      }
      return commit(next, actor)
    },

    /**
     * The one-time handover from a window's localStorage. Accepted only while
     * main holds no record; once one exists every offer is refused and answered
     * with main's record, which the window adopts.
     */
    migrate(raw: unknown): AgentLaunchSettingsWriteResult {
      const existing = loadOnce()
      if (existing) return { record: existing, changed: false, persisted: Promise.resolve() }
      return commit(normalizeAgentLaunchSettings(raw), 'system')
    },

    /** Resolves when every write queued so far has settled. */
    settled(): Promise<void> {
      return writeQueue
    },

    /** Called with the new record after every write that changed it. */
    subscribe(listener: (record: AgentLaunchSettingsRecord) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
