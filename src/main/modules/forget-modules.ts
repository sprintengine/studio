import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { readModuleOverridesSync, writeModuleOverrides } from '../module-host/enablement-store'
import { deleteModuleSecrets } from '../module-host/module-secrets'

// Everything the app kept for a module outside its folder, dropped once the
// module is uninstalled — by whichever door: Settings → Modules, or the
// marketplace's own Uninstall. Its enablement choice, its stored secrets and
// its per-user storage would otherwise wait under its id for the next module
// to take that id, which would start with the keys and data the person gave
// this one. Trust is revoked by whoever removed the folder.
//
// Storage a module kept inside a workspace (`.sprintengine/modules/<id>`) is
// the project's, and stays with it.
export async function forgetModules(userData: string, moduleIds: readonly string[]): Promise<void> {
  const ids = moduleIds.filter(isModuleIdSegment)
  if (ids.length === 0) return
  const overrides = readModuleOverridesSync(userData)
  if (ids.some((id) => id in overrides)) {
    const next = { ...overrides }
    for (const id of ids) delete next[id]
    await writeModuleOverrides(userData, next)
  }
  for (const id of ids) {
    await deleteModuleSecrets(userData, id).catch(() => undefined)
    await rm(join(userData, 'module-storage', id), { recursive: true, force: true }).catch(() => undefined)
  }
}

export function isModuleIdSegment(id: string): boolean {
  return id.length > 0 && id.length <= 200 && !/[\\/\0]/.test(id) && id !== '.' && id !== '..'
}
