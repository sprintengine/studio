import { app, type IpcMain } from 'electron'

import { normalizeModuleOverrides, type ModuleEnablementOverrides } from '../../shared/modules/manifest'
import { writeModuleOverrides, type ModuleEnablementWriteResult } from '../module-host/enablement-store'

// Kernel-level (not feature-owned) IPC: the renderer pushes its module
// enablement overrides here so main can gate modules. The renderer owns the
// source of truth (persisted settings), so there's no read path back — main
// caches the latest pushed value and applies live-capable main modules.
export type ModuleEnablementLiveApplier = (
  overrides: ModuleEnablementOverrides,
) => void | ModuleEnablementWriteResult | Promise<void | ModuleEnablementWriteResult>

export function registerModuleEnablementIpc(
  ipcMain: IpcMain,
  options: { applyLive?: ModuleEnablementLiveApplier } = {},
): void {
  ipcMain.handle(
    'modules:set-enablement',
    async (_event, overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult> => {
      const normalized = normalizeModuleOverrides(overrides)
      const written = await writeModuleOverrides(app.getPath('userData'), normalized)
      if (!written.ok) return written

      try {
        const liveResult = await options.applyLive?.(normalized)
        if (liveResult && !liveResult.ok) return liveResult
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'live_apply_failed' }
      }
      return written
    },
  )
}
