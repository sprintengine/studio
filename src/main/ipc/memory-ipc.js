import { indexMemoryGraph, readMemoryPreview, resolveMemoryRoot, } from '../memory-graph';
export function registerMemoryIpc(ipcMain) {
    ipcMain.handle('memory:resolve-root', async (_, input) => {
        return resolveMemoryRoot(input.workspaceRoot, input.relativeRoot);
    });
    ipcMain.handle('memory:index', async (_, input) => {
        return indexMemoryGraph(input.workspaceRoot, input.relativeRoot);
    });
    ipcMain.handle('memory:read-preview', async (_, input) => {
        return readMemoryPreview(input.workspaceRoot, input.relativeRoot, input.relativePath);
    });
}
