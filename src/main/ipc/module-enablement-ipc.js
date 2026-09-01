import { app } from 'electron';
import { normalizeModuleOverrides } from '../../shared/modules/manifest';
import { writeModuleOverrides } from '../module-host/enablement-store';
export function registerModuleEnablementIpc(ipcMain, options = {}) {
    ipcMain.handle('modules:set-enablement', async (_event, overrides) => {
        const normalized = normalizeModuleOverrides(overrides);
        const written = await writeModuleOverrides(app.getPath('userData'), normalized);
        if (!written.ok)
            return written;
        try {
            const liveResult = await options.applyLive?.(normalized);
            if (liveResult && !liveResult.ok)
                return liveResult;
        }
        catch (err) {
            return { ok: false, message: err instanceof Error ? err.message : 'live_apply_failed' };
        }
        return written;
    });
}
