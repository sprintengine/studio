import { existsSync, readFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'

import { normalizeModuleOverrides, type ModuleEnablementOverrides } from '../../shared/modules/manifest'

// Main-readable mirror of the renderer's appSettings.modules override. The
// renderer is the source of truth (the user toggles modules there); it pushes
// changes here via IPC so the main process can gate module IPC and sidecar
// spawning at the next startup. main can't read renderer localStorage, hence
// this small JSON cache in userData.

const FILE_NAME = 'module-enablement.json'

export function moduleEnablementPath(userDataDir: string): string {
  return join(userDataDir, FILE_NAME)
}

export function parseModuleOverrides(raw: string): ModuleEnablementOverrides {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  return normalizeModuleOverrides(parsed)
}

// Synchronous so it can run during main startup, before the first window /
// app-ready, exactly where loadMainModules needs it. A missing or malformed
// file means "no overrides" — every module falls back to its manifest default.
export function readModuleOverridesSync(userDataDir: string): ModuleEnablementOverrides {
  const path = moduleEnablementPath(userDataDir)
  if (!existsSync(path)) return {}
  try {
    return parseModuleOverrides(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export type ModuleEnablementWriteResult = { ok: boolean; message?: string }

export async function writeModuleOverrides(
  userDataDir: string,
  overrides: ModuleEnablementOverrides
): Promise<ModuleEnablementWriteResult> {
  const normalized = normalizeModuleOverrides(overrides)
  const path = moduleEnablementPath(userDataDir)
  try {
    await mkdir(userDataDir, { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(normalized), { mode: 0o600 })
    await rename(tmp, path)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'write_failed' }
  }
}
