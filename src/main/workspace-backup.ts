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

  constructor(private readonly deps: WorkspaceBackupServiceDeps) {}

  private get backupPath(): string {
    return join(this.deps.resolveUserDataDir(), BACKUP_FILE_NAME)
  }

  async write(payload: WorkspaceBackupPayload): Promise<{ ok: boolean; message?: string }> {
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
