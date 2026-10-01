/**
 * The note an update leaves for the build that starts after it.
 *
 * Written just before the app hands over to the installer, read and deleted at
 * the next start. The version that starts is the verdict: the version the note
 * was going to is "Updated to X"; the version it came from is a failed update,
 * which otherwise looks exactly like a restart that did nothing. Either way the
 * person hears about it once, and the diagnostics log has the steps.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppUpdateInstallOutcome } from '../shared/electron-api'

const FILE_NAME = 'update-install.json'

/** Older than this, a note is from some other life of the install and says nothing. */
const NOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type UpdateInstallNote = {
  fromVersion: string
  toVersion: string
  startedAt: string
  platform: NodeJS.Platform
  installDir: string | null
  requiresAdmin: boolean
  /** Set when the app already knows the update failed (the installer would not start). */
  failureReason?: string
}

function isNote(value: unknown): value is UpdateInstallNote {
  if (!value || typeof value !== 'object') return false
  const note = value as Record<string, unknown>
  return (
    typeof note['fromVersion'] === 'string' &&
    typeof note['toVersion'] === 'string' &&
    typeof note['startedAt'] === 'string' &&
    typeof note['platform'] === 'string'
  )
}

/** What the note says about the version now running, or null when it says nothing. */
export function installOutcomeFromNote(
  note: UpdateInstallNote,
  runningVersion: string,
  now: number,
): AppUpdateInstallOutcome | null {
  const startedAt = Date.parse(note.startedAt)
  if (!Number.isFinite(startedAt) || now - startedAt > NOTE_MAX_AGE_MS || startedAt - now > NOTE_MAX_AGE_MS) return null
  if (runningVersion === note.toVersion) {
    return { kind: 'updated', version: note.toVersion, fromVersion: note.fromVersion, message: null }
  }
  if (runningVersion === note.fromVersion) {
    return {
      kind: 'failed',
      version: note.toVersion,
      fromVersion: note.fromVersion,
      message: note.failureReason
        ? `${note.failureReason} SprintEngine Studio is still on ${note.fromVersion}.`
        : note.requiresAdmin
          ? `The installer did not finish, so SprintEngine Studio is still on ${note.fromVersion}. Installing into ${note.installDir ?? 'this folder'} needs administrator permission.`
          : `The installer did not finish, so SprintEngine Studio is still on ${note.fromVersion}.`,
    }
  }
  // A third version: something else installed over it since. Not this note's news.
  return null
}

export type UpdateInstallNoteStore = ReturnType<typeof createUpdateInstallNoteStore>

export function createUpdateInstallNoteStore(deps: { resolveUserDataDir: () => string }) {
  const filePath = () => join(deps.resolveUserDataDir(), FILE_NAME)
  return {
    /** Synchronous and small: it is written on the way out, and must land before the process goes. */
    write(note: UpdateInstallNote): void {
      const target = filePath()
      const tmp = `${target}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(note)}\n`, 'utf8')
      renameSync(tmp, target)
    },
    /** Read the note and delete it: it is news once. Never throws. */
    consume(): UpdateInstallNote | null {
      const target = filePath()
      let note: UpdateInstallNote | null = null
      try {
        const raw: unknown = JSON.parse(readFileSync(target, 'utf8'))
        note = isNote(raw) ? raw : null
      } catch {
        return null
      }
      try {
        unlinkSync(target)
      } catch {
        // Left behind, it is read again next start and aged out after a day.
      }
      return note
    },
  }
}
