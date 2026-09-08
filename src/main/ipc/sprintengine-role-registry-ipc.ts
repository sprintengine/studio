import { app, type IpcMain } from 'electron'
import { join } from 'path'

import { clearRoleCatalogCache } from '../mobile/sprintengine/role-catalog'
import {
  defaultUserRoleRegistryRoot,
  installRoleFolder,
  type RoleInstallResult,
} from '../sprintengine-role-registry'

// Kernel-level IPC for the user-global Sprint Engine role registry. It's pure
// filesystem config management (validate + copy declarative manifests), so it's
// always available and does not depend on the Sprint Engine capability module or
// its MCP runtime. Discovery of installed roles flows through the existing
// sprintengine registry MCP read.
// Installing roles changes what the phone may staff, and the mobile snapshot caches
// the resolved registry (it costs a process to read). Every write here invalidates
// that cache, so a role the user just authored is offerable from the phone on the
// next snapshot rather than up to a TTL later.
async function withRoleCatalogInvalidation<T>(write: Promise<T>): Promise<T> {
  const result = await write
  clearRoleCatalogCache()
  return result
}

// The shipped specialist-pack source tree (17 role manifests + their soul
// skills), un-shipped from the bundled registry root in MC-1587. Packaged builds
// receive it via package.json build.extraResources ('resources/specialist-pack'
// → 'resources/specialist-pack'), so it resolves under process.resourcesPath;
// dev checkouts read it from the repo. Its shape is a registry root, so
// installRoleFolder consumes it directly.
function bundledSpecialistPackDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'specialist-pack')
    : join(app.getAppPath(), 'resources', 'specialist-pack')
}

export function registerSprintEngineRoleRegistryIpc(ipcMain: IpcMain): void {
  // One-time MC-1587 update-migration: install the un-shipped specialist pack
  // from the shipped source tree into the user-global root, for users who had
  // the bundled pack enabled before it stopped being bundled. The renderer owns
  // the run-once guard (appSettings.specialistPacks.migratedBundledPack) and the
  // enabled/disabled decision; this handler only performs the copy and
  // invalidates the role catalog so the session reflects the new roles.
  ipcMain.handle('sprintengine:specialist-pack:install-bundled', (): Promise<RoleInstallResult> => {
    return withRoleCatalogInvalidation(installRoleFolder(bundledSpecialistPackDir(), defaultUserRoleRegistryRoot()))
  })
}
