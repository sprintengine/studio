import { app, type IpcMain } from 'electron'

import type { ModuleEnablementOverrides } from '../../shared/modules/manifest'
import {
  readModuleOverridesSync,
  writeModuleOverrides,
  type ModuleEnablementWriteResult,
} from '../module-host/enablement-store'

// Kernel-level (not feature-owned) IPC: lets the renderer read the main-cached
// module overrides and push updates so main can gate modules on next launch.
export function registerModuleEnablementIpc(ipcMain: IpcMain): void {
  ipcMain.handle('modules:get-enablement', (): ModuleEnablementOverrides => {
    return readModuleOverridesSync(app.getPath('userData'))
  })

  ipcMain.handle(
    'modules:set-enablement',
    (_event, overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult> => {
      return writeModuleOverrides(app.getPath('userData'), overrides ?? {})
    }
  )
}
