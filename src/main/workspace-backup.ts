import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { WorkspaceBackupPayload, WorkspaceBackupReadResult } from '../shared/electron-api'
import type { WorkspaceSyncState } from '../shared/workspace-sync'

const BACKUP_FILE_NAME = 'workspace-backup.json'

/** The registry fields the backup's registry envelope carries. */
export type WorkspaceBackupRegistry = Pick<
  WorkspaceSyncState,
  'workspaces' | 'activeWorkspaceId' | 'workspaceWindows' | 'primaryWorkspaceWindowId'
>

export type WorkspaceBackupServiceDeps = {
  resolveUserDataDir: () => string
  /**
   * Main's registry. A window sends only the settings envelope it owns, and
   * the registry half of the backup is taken from here, so the window never
   * serializes a registry that is main's. Absent in tests of the file format.
   */
  readRegistry?: () => WorkspaceBackupRegistry
  /**
   * The least time between two backups that serialize main's registry. A
   * registry of a few hundred workspaces is a megabyte or more of JSON, and a
   * window asks for a backup a second after any change to its workspace list,
   * so a busy session would otherwise pay for that serialization every few
   * seconds. A request inside the interval is held, the newest one wins, and
   * it is written when the interval ends. Zero (the default) writes each one.
   */
  minRegistryIntervalMs?: number
  now?: () => number
}

/**
 * The payload a window sends: `{ settings }` with no registry. Anything else
 * (an older build's `{ registry, settings }` pair, or a bare envelope) is
 * written as it arrived.
 */
function settingsOnlyBackupData(data: unknown): { settings: unknown } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if ('registry' in data || !('settings' in data)) return null
  return data as { settings: unknown }
}

export class WorkspaceBackupService {
  private inFlightWrite: Promise<void> = Promise.resolve()
  private lastRegistryWriteAt = Number.NEGATIVE_INFINITY
  private heldWrite: WorkspaceBackupPayload | null = null
  private heldTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: WorkspaceBackupServiceDeps) {}

  /**
   * Whether this write should wait for the registry interval, holding it as
   * the one to write when the interval ends. Only a write that composes main's
   * registry is held: an older build's full pair costs main nothing to write.
   */
  private holdForInterval(payload: WorkspaceBackupPayload): boolean {
    const interval = this.deps.minRegistryIntervalMs ?? 0
    if (interval <= 0 || !this.deps.readRegistry || !settingsOnlyBackupData(payload.data)) return false
    const now = (this.deps.now ?? Date.now)()
    const wait = this.lastRegistryWriteAt + interval - now
    if (wait <= 0 && this.heldTimer === null) {
      this.lastRegistryWriteAt = now
      return false
    }
    this.heldWrite = payload
    if (this.heldTimer === null) {
      this.heldTimer = setTimeout(
        () => {
          this.heldTimer = null
          const held = this.heldWrite
          this.heldWrite = null
          if (held) void this.write(held)
        },
        Math.max(wait, 0),
      )
      // A backup is not a reason to keep the app from quitting.
      this.heldTimer.unref?.()
    }
    return true
  }

  private get backupPath(): string {
    return join(this.deps.resolveUserDataDir(), BACKUP_FILE_NAME)
  }

  async write(payload: WorkspaceBackupPayload): Promise<{ ok: boolean; message?: string }> {
    if (this.holdForInterval(payload)) return { ok: true, message: 'deferred' }
    let serialized: string
    try {
      const composed = this.withRegistry(payload)
      // The backup mirrors a non-empty registry only; an intentionally empty
      // one never replaces the last good copy.
      if (composed === null) return { ok: true, message: 'registry_empty' }
      serialized = JSON.stringify(composed)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'serialize_failed',
      }
    }

    // Serialize writes so a slower write cannot clobber a newer payload.
    const previous = this.inFlightWrite
    let releaseCurrent: () => void = () => {}
    this.inFlightWrite = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    await previous

    try {
      const path = this.backupPath
      const dir = join(path, '..')
      await mkdir(dir, { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, serialized, { mode: 0o600 })
      await rename(tmp, path)
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'unknown_write_error',
      }
    } finally {
      releaseCurrent()
    }
  }

  /**
   * The payload with main's registry filled in as the registry envelope, in
   * the `{ state, version }` shape the window's recovery path parses. Null
   * when main's registry is empty.
   */
  private withRegistry(payload: WorkspaceBackupPayload): WorkspaceBackupPayload | null {
    const settingsOnly = this.deps.readRegistry ? settingsOnlyBackupData(payload.data) : null
    if (!settingsOnly || !this.deps.readRegistry) return payload
    const registry = this.deps.readRegistry()
    if (registry.workspaces.length === 0) return null
    const registryEnvelope = JSON.stringify({
      state: {
        workspaces: registry.workspaces,
        activeWorkspaceId: registry.activeWorkspaceId,
        workspaceWindows: registry.workspaceWindows,
        primaryWorkspaceWindowId: registry.primaryWorkspaceWindowId,
        workspaceRegistryEmptyState: null,
      },
      version: payload.version,
    })
    return { ...payload, data: { registry: registryEnvelope, settings: settingsOnly.settings } }
  }

  async read(): Promise<WorkspaceBackupReadResult> {
    let raw: string
    try {
      raw = await readFile(this.backupPath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') return { ok: false, reason: 'missing' }
      return {
        ok: false,
        reason: 'unreadable',
        message: error instanceof Error ? error.message : 'unknown_read_error',
      }
    }

    try {
      const parsed = JSON.parse(raw) as WorkspaceBackupPayload
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.version !== 'number' ||
        typeof parsed.writtenAt !== 'string'
      ) {
        return { ok: false, reason: 'parse_error', message: 'malformed_payload' }
      }
      return { ok: true, payload: parsed }
    } catch (error) {
      return {
        ok: false,
        reason: 'parse_error',
        message: error instanceof Error ? error.message : 'unknown_parse_error',
      }
    }
  }
}

export function createWorkspaceBackupService(deps: WorkspaceBackupServiceDeps): WorkspaceBackupService {
  return new WorkspaceBackupService(deps)
}
