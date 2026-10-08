/**
 * Main-owned mirror of the model-written chat titles setting.
 *
 * Same one-way push contract as background mode and the usage-data choice: the
 * renderer owns the preference (`appSettings.textGeneration`) and pushes it on
 * change and when a window mounts; main persists a copy under its data
 * directory and reads it synchronously. Main titles a chat itself
 * (`chat-titler.ts`), and the chats that most need it are the ones started
 * with no window watching: from a phone, a paired machine, a schedule, or
 * while the app runs in the background with every window closed.
 *
 * ABSENT READS AS ON, with the engine left to the first supported CLI that is
 * installed, which is exactly the renderer's own default
 * (`normalizeTextGenerationSettings`, shared so the two cannot drift). The
 * mirror only stands in for a window that has not spoken yet, and a window
 * that never pushed is one still showing that default: a fresh profile, or
 * one whose first chat came from a phone before any window here opened. Off
 * is a choice the person makes in Settings, it is pushed, and it survives a
 * restart. A file that cannot be parsed has told us nothing, so it reads as
 * absent too.
 *
 * Deliberately carries no revision counter: main never writes this value and
 * never broadcasts it back, so there is no echo to order.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from '../../shared/records'
import { normalizeTextGenerationSettings, type TextGenerationSettings } from '../../shared/text-generation/contract'

const FILE_NAME = 'text-generation.json'

export type TextGenerationSettingsStoreDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type TextGenerationSettingsStore = ReturnType<typeof createTextGenerationSettingsStore>

export function createTextGenerationSettingsStore(deps: TextGenerationSettingsStoreDeps) {
  let cached: TextGenerationSettings | null = null

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  // The normalizer checks every field's type itself, so anything shaped like
  // an object can be handed to it; anything else is nothing set.
  function read(value: unknown): TextGenerationSettings {
    return normalizeTextGenerationSettings(isRecord(value) ? (value as Partial<TextGenerationSettings>) : undefined)
  }

  return {
    /** The setting the titler reads for each chat it titles. Never throws. */
    get(): TextGenerationSettings {
      if (cached !== null) return cached
      try {
        cached = read(JSON.parse(readFileSync(filePath(), 'utf8')))
      } catch {
        cached = read(undefined)
      }
      return cached
    },

    /** Adopt a renderer push. Idempotent: an unchanged value never rewrites the file. */
    set(value: unknown): void {
      const next = read(value)
      // `get()` first so the compare is against the persisted value on the
      // very first push of a session, not against an unread cache.
      if (JSON.stringify(this.get()) === JSON.stringify(next)) return
      cached = next
      const target = filePath()
      const tmp = `${target}.tmp-${process.pid}`
      try {
        writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8')
        renameSync(tmp, target)
      } catch (error) {
        try {
          unlinkSync(tmp)
        } catch {
          // The temp file may never have been created; nothing to clean up.
        }
        // In memory it still applies, so the choice takes effect now; it just
        // will not survive a restart, which is what the warning says.
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Chat title setting not saved',
          message:
            'The model-written chat titles setting could not be written to disk. It applies for this session but will not survive a restart.',
          details: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
