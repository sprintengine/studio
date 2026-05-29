import type { IpcMain } from 'electron'

import {
  defaultUserRoleRegistryRoot,
  installRoleFolder,
  loadUserRoleManifests,
  type RoleInstallResult,
  type UserRoleListResult,
} from '../sprintengine-role-registry'

// Kernel-level IPC for the user-global Sprint Engine role registry. It's pure
// filesystem config management (validate + copy declarative manifests), so it's
// always available and does not depend on the Sprint Engine capability module or
// its MCP runtime — the user can curate global roles regardless of which modules
// are enabled. Discovery of installed roles flows through the existing
// sprintengine registry MCP read.
export function registerSprintEngineRoleRegistryIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'sprintengine:user-roles:install-folder',
    (_event, srcDir: unknown): Promise<RoleInstallResult> => {
      if (typeof srcDir !== 'string' || srcDir.trim().length === 0) {
        return Promise.resolve({
          ok: false,
          installedRoles: [],
          installedSkills: [],
          rejected: [],
          message: 'No folder selected.',
        })
      }
      return installRoleFolder(srcDir, defaultUserRoleRegistryRoot())
    }
  )

  ipcMain.handle('sprintengine:user-roles:list', (): Promise<UserRoleListResult> => {
    return loadUserRoleManifests(defaultUserRoleRegistryRoot())
  })
}
