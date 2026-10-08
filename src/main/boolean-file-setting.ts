/**
 * One on/off setting main keeps in its own small JSON file under userData,
 * read **synchronously** (the reads happen at moments with no renderer to ask:
 * the last window closing, a quit) and written whole on change.
 *
 * The file holds `{ [key]: boolean }`. Only the value that is NOT the fallback,
 * written as exactly that boolean, moves the setting off its fallback: an
 * absent, unreadable or malformed file, or a key holding anything else, reads
 * as the fallback. Each setting picks the fallback a store it cannot trust
 * should cost the person least.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import { isRecord } from '../shared/records'
import { writeFileAtomicSync } from '../server/platform/atomic-file'

export type BooleanFileSettingDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type BooleanFileSettingSpec = {
  fileName: string
  key: string
  /** What an absent, unreadable or malformed file reads as. */
  fallback: boolean
  /** The warning logged when a change cannot be written; it still applies for the session. */
  notPersisted: { title: string; message: string }
}

export type BooleanFileSetting = {
  /** The current value. Never throws. */
  isEnabled(): boolean
  /** Idempotent: an unchanged value never rewrites the file. */
  set(enabled: boolean): void
}

export function createBooleanFileSetting(spec: BooleanFileSettingSpec, deps: BooleanFileSettingDeps): BooleanFileSetting {
  let cached: boolean | null = null

  function filePath(): string {
    return join(deps.resolveUserDataDir(), spec.fileName)
  }

  function isEnabled(): boolean {
    if (cached !== null) return cached
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
      cached = isRecord(raw) && raw[spec.key] === !spec.fallback ? !spec.fallback : spec.fallback
    } catch {
      cached = spec.fallback
    }
    return cached
  }

  return {
    isEnabled,

    set(enabled: boolean): void {
      const next = enabled === true
      // `isEnabled()` first so the compare is against the persisted value on the
      // very first change of a session, not against an unread cache.
      if (isEnabled() === next) return
      cached = next
      try {
        writeFileAtomicSync(filePath(), `${JSON.stringify({ [spec.key]: next })}\n`)
      } catch (error) {
        // In memory it still applies for this session, so the choice takes
        // effect now; it just will not survive a restart, which is what the
        // warning says.
        deps.logDiagnostic?.({
          level: 'warning',
          title: spec.notPersisted.title,
          message: spec.notPersisted.message,
          details: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
