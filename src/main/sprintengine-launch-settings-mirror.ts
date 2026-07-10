/**
 * Main-side store for the renderer's agent-launch settings (sprint-runtime-
 * ownership Phase 2; shapes in `src/shared/sprintengine/launch-settings.ts`).
 *
 * The renderer pushes on settings change (`sprintengine:launch-settings:sync`);
 * the main sprint scheduler reads synchronously at spawn time. A copy persists
 * under userData (atomic write, fail-soft read — the module-enablement store
 * pattern) so a fresh boot launches with the last-known settings before any
 * window has pushed.
 */
import { readFileSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  emptySprintEngineLaunchSettings,
  normalizeSprintEngineLaunchSettings,
  type SprintEngineLaunchSettings,
} from '../shared/sprintengine/launch-settings'

const FILE_NAME = 'sprintengine-launch-settings.json'

export type SprintEngineLaunchSettingsMirrorDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type SprintEngineLaunchSettingsMirror = ReturnType<typeof createSprintEngineLaunchSettingsMirror>

export function createSprintEngineLaunchSettingsMirror(deps: SprintEngineLaunchSettingsMirrorDeps) {
  let current: SprintEngineLaunchSettings | null = null
  let loadedFromDisk = false
  const listeners = new Set<(settings: SprintEngineLaunchSettings) => void>()

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  function loadOnce(): SprintEngineLaunchSettings {
    if (current && loadedFromDisk) return current
    loadedFromDisk = true
    try {
      const raw = readFileSync(filePath(), 'utf8')
      current = normalizeSprintEngineLaunchSettings(JSON.parse(raw))
    } catch {
      current = current ?? emptySprintEngineLaunchSettings()
    }
    return current
  }

  async function persist(settings: SprintEngineLaunchSettings): Promise<void> {
    const target = filePath()
    const tmp = `${target}.tmp-${process.pid}`
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await rename(tmp, target)
    } catch (error) {
      await unlink(tmp).catch(() => undefined)
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Agent launch settings not persisted',
        message: 'The mirrored launch settings could not be written to disk; in-memory values still apply.',
        details: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    get(): SprintEngineLaunchSettings {
      return loadOnce()
    },
    set(raw: unknown): void {
      const settings = normalizeSprintEngineLaunchSettings(raw)
      current = settings
      loadedFromDisk = true
      void persist(settings)
      for (const listener of listeners) listener(settings)
    },
    subscribe(listener: (settings: SprintEngineLaunchSettings) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
