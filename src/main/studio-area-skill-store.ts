// Which of the built-in plugin's area skills the person has opted into, and
// which suggestions they turned down. One file under userData, for every
// workspace this profile opens (shared/studio-area-skills.ts has the ruling).
//
// Main owns it rather than the renderer because main is what reads it: every
// workspace install and every launch-home sync asks "which skills?", often with
// no window open. The renderer asks and changes it over IPC.
//
// Absent, unreadable or malformed reads as "nothing chosen", which installs no
// area skill. That is the default a fresh machine gets anyway, so a store that
// cannot be trusted costs the person a skill they can switch back on, never an
// instruction to their agents they did not ask for.

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  normaliseStudioAreaSkillChoices,
  type StudioAreaSkillChoices,
  type StudioAreaSkillId,
} from '../shared/studio-area-skills'

const FILE_NAME = 'studio-area-skills.json'

export type StudioAreaSkillStore = {
  /** Synchronous: the install path reads it on every workspace pass. */
  read(): StudioAreaSkillChoices
  /** The opted-in skill directory names, in list order. */
  enabledSkillDirs(): readonly StudioAreaSkillId[]
  setEnabled(id: StudioAreaSkillId, enabled: boolean): Promise<StudioAreaSkillChoices>
  dismiss(id: StudioAreaSkillId): Promise<StudioAreaSkillChoices>
  /** Called after every change that altered the record. Returns an unsubscribe. */
  onChange(listener: (choices: StudioAreaSkillChoices) => void): () => void
}

export function createStudioAreaSkillStore(deps: {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}): StudioAreaSkillStore {
  let cached: StudioAreaSkillChoices | null = null
  const listeners = new Set<(choices: StudioAreaSkillChoices) => void>()
  // Writes are chained so two quick toggles land in the order they were made.
  let writing: Promise<unknown> = Promise.resolve()

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  function read(): StudioAreaSkillChoices {
    if (cached) return cached
    try {
      cached = normaliseStudioAreaSkillChoices(JSON.parse(readFileSync(filePath(), 'utf8')))
    } catch {
      cached = normaliseStudioAreaSkillChoices(null)
    }
    return cached
  }

  async function commit(next: StudioAreaSkillChoices): Promise<StudioAreaSkillChoices> {
    const before = read()
    const normalised = normaliseStudioAreaSkillChoices(next)
    if (JSON.stringify(before) === JSON.stringify(normalised)) return before
    cached = normalised
    const path = filePath()
    writing = writing.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true })
        const temp = `${path}.${process.pid}.tmp`
        await writeFile(temp, `${JSON.stringify(normalised, null, 2)}\n`, 'utf8')
        await rename(temp, path)
      } catch (error) {
        // The choice stands for this run; only the record failed.
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Studio skill choice not saved',
          message: 'The choice applies until the app quits, and is asked again after that.',
          details: error instanceof Error ? error.message : String(error),
        })
      }
    })
    await writing
    for (const listener of listeners) listener(normalised)
    return normalised
  }

  return {
    read,
    enabledSkillDirs: () => read().enabled,
    setEnabled(id, enabled) {
      const current = read()
      return commit({
        enabled: enabled ? [...current.enabled, id] : current.enabled.filter((one) => one !== id),
        // Switching one off is an answer too: the surface must not offer back
        // a skill the person has just turned off.
        dismissed: enabled ? current.dismissed : [...current.dismissed, id],
      })
    },
    dismiss(id) {
      const current = read()
      return commit({ enabled: current.enabled, dismissed: [...current.dismissed, id] })
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
