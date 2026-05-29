import type { IpcMain } from 'electron'

import {
  defaultUserLayoutTemplateRoot,
  installLayoutTemplateFolder,
  loadUserLayoutTemplates,
  type LayoutTemplateInstallResult,
  type UserLayoutTemplateListResult,
} from '../layout-template-registry'

// Kernel-level IPC for the user-global layout-template registry. Pure filesystem
// config management (validate + copy declarative FlexLayout JSON), so it's
// always available and independent of any capability module.
export function registerLayoutTemplateRegistryIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'layout-templates:install-folder',
    (_event, srcDir: unknown): Promise<LayoutTemplateInstallResult> => {
      if (typeof srcDir !== 'string' || srcDir.trim().length === 0) {
        return Promise.resolve({ ok: false, installed: [], rejected: [], message: 'No folder selected.' })
      }
      return installLayoutTemplateFolder(srcDir, defaultUserLayoutTemplateRoot())
    }
  )

  ipcMain.handle('layout-templates:list', (): Promise<UserLayoutTemplateListResult> => {
    return loadUserLayoutTemplates(defaultUserLayoutTemplateRoot())
  })
}
