import { clearMemoryActivityHistory, getMemoryActivityStatus, getMemoryActivitySynapses, installMemoryActivityHook, isMemoryActivityInstalled, startMemoryActivityWatcher, stopMemoryActivityWatcher, uninstallMemoryActivityHook, } from '../memory-activity';
export function registerMemoryActivityIpc(ipcMain) {
    ipcMain.handle('memory-activity:install', async (_, input) => {
        if (!input?.workspaceRoot || !input.memoryRelativeRoot) {
            return { ok: false, message: 'Workspace and knowledge root are required.' };
        }
        const result = await installMemoryActivityHook(input.workspaceRoot, input.memoryRelativeRoot);
        if (result.ok) {
            await startMemoryActivityWatcher(input.workspaceRoot, input.memoryRelativeRoot);
        }
        return result;
    });
    ipcMain.handle('memory-activity:uninstall', async (_, input) => {
        if (!input?.workspaceRoot)
            return { ok: false, message: 'Workspace root is required.' };
        stopMemoryActivityWatcher(input.workspaceRoot);
        return uninstallMemoryActivityHook(input.workspaceRoot);
    });
    ipcMain.handle('memory-activity:start-watching', async (_, input) => {
        if (input?.workspaceRoot && input.memoryRelativeRoot) {
            await startMemoryActivityWatcher(input.workspaceRoot, input.memoryRelativeRoot);
        }
        return { ok: true };
    });
    ipcMain.handle('memory-activity:stop-watching', async (_, input) => {
        if (input?.workspaceRoot)
            stopMemoryActivityWatcher(input.workspaceRoot);
        return { ok: true };
    });
    ipcMain.handle('memory-activity:get-status', async (_, input) => {
        return getMemoryActivityStatus(input?.workspaceRoot ?? null);
    });
    ipcMain.handle('memory-activity:get-synapses', async (_, input) => {
        if (!input?.workspaceRoot)
            return [];
        return getMemoryActivitySynapses(input.workspaceRoot);
    });
    ipcMain.handle('memory-activity:is-installed', async (_, input) => {
        if (!input?.workspaceRoot)
            return false;
        return isMemoryActivityInstalled(input.workspaceRoot);
    });
    ipcMain.handle('memory-activity:clear-history', async (_, input) => {
        if (input?.workspaceRoot)
            await clearMemoryActivityHistory(input.workspaceRoot);
        return { ok: true };
    });
}
