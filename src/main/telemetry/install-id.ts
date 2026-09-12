/**
 * The install identifier: one random UUID per profile, minted on first read and
 * kept under userData.
 *
 * This is the whole identity model, deliberately. It is NOT derived from an
 * account, a machine, a MAC address, a hostname, or any file another vendor's
 * CLI left on disk — it is a coin flip, so it says "a SprintEngine install did
 * this" and nothing else. The cost is honest and worth stating: one person on a
 * laptop and a desktop counts as two, and a wiped profile counts as new.
 *
 * Not hashed. Hashing a value that was already random only makes it look like
 * it was derived from something.
 *
 * A read that cannot reach disk returns a fresh id that is never persisted:
 * telemetry from a locked-down profile is anonymous per process rather than
 * absent, and no caller has to handle "there is no identity". That is also why
 * the mint is lazy — nothing touches disk until something is actually sent.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE_NAME = 'telemetry-install-id.json'

// A v4 UUID as written by `randomUUID`. Anything else on disk — a truncated
// write, a hand-edited file, a value carried over from something that is not
// this — is discarded and replaced rather than reported as an identity.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export type InstallIdDeps = {
  resolveUserDataDir: () => string
  newId?: () => string
}

export type InstallId = {
  /** The persisted id. */
  value: string
  /**
   * Whether this call minted it. The `app.boot` event reports this as
   * `firstRun`, which is how "new installs" is separated from "opened again"
   * without a second event or a server-side join.
   */
  created: boolean
  /** False when the id could not be written; it lives for this process only. */
  persisted: boolean
}

export function readInstallId(deps: InstallIdDeps): InstallId {
  const newId = deps.newId ?? randomUUID
  let target: string
  try {
    target = join(deps.resolveUserDataDir(), FILE_NAME)
  } catch {
    return { value: newId(), created: true, persisted: false }
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(target, 'utf8'))
    const stored =
      Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).installId
        : undefined
    if (typeof stored === 'string' && UUID_PATTERN.test(stored)) {
      return { value: stored, created: false, persisted: true }
    }
  } catch {
    // Absent, unreadable or malformed all take the mint path below. A profile
    // that cannot be read is a profile we have not seen.
  }

  const value = newId()
  // Same write-then-rename as the other userData stores: a half-written id file
  // would mint a NEW id on the next boot and double-count the install.
  const tmp = `${target}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify({ installId: value })}\n`, 'utf8')
    renameSync(tmp, target)
    return { value, created: true, persisted: true }
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return { value, created: true, persisted: false }
  }
}
