import { app, type IpcMain } from 'electron'

import type { ModuleEnablementOverrides } from '../../shared/modules/manifest'
import { writeModuleOverrides, type ModuleEnablementWriteResult } from '../module-host/enablement-store'

// Kernel-level (not feature-owned) IPC: the renderer pushes its module
// enablement overrides here so main can gate modules at the next launch. The
// renderer owns the source of truth (persisted settings), so there's no read
// path back — main only caches the latest pushed value.
export function registerModuleEnablementIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'modules:set-enablement',
    (_event, overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult> => {
      return writeModuleOverrides(app.getPath('userData'), overrides ?? {})
    }
  )
}
