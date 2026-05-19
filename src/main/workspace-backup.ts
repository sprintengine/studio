import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { WorkspaceBackupPayload, WorkspaceBackupReadResult } from '../shared/electron-api'

const BACKUP_FILE_NAME = 'workspace-backup.json'

export type WorkspaceBackupServiceDeps = {
  resolveUserDataDir: () => string
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
      serialized = JSON.stringify(payload)
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
        !parsed
        || typeof parsed !== 'object'
        || typeof parsed.version !== 'number'
        || typeof parsed.writtenAt !== 'string'
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
