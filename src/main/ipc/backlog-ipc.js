import { addOrUpdateBacklogLink, createBacklogEpic, ensureBacklogItemIds, ensureBacklogObjectRecords, moveBacklogObjectSource, readBacklogObjectStore, readBacklogWorkspaceKey, removeBacklogLink, removeBacklogObjectRecord, updateBacklogDependencies, updateBacklogMockups, updateBacklogEpic, updateBacklogEpicColor, updateBacklogHighlight, updateBacklogModuleMetadata, updateBacklogStatus, updateBacklogTriage, updateBacklogType, } from '../backlog-service';
export function registerBacklogIpc(ipcMain) {
    ipcMain.handle('backlog:read-object-store', (_event, workspaceRoot) => {
        return readBacklogObjectStore(workspaceRoot);
    });
    ipcMain.handle('backlog:ensure-object-records', (_event, workspaceRoot, items) => {
        return ensureBacklogObjectRecords(workspaceRoot, items);
    });
    ipcMain.handle('backlog:ensure-item-ids', (_event, input) => {
        return ensureBacklogItemIds(input);
    });
    ipcMain.handle('backlog:read-workspace-key', (_event, workspaceRoot) => {
        return readBacklogWorkspaceKey(workspaceRoot);
    });
    ipcMain.handle('backlog:update-status', (_event, input) => {
        return updateBacklogStatus(input);
    });
    ipcMain.handle('backlog:update-type', (_event, input) => {
        return updateBacklogType(input);
    });
    ipcMain.handle('backlog:update-triage', (_event, input) => {
        return updateBacklogTriage(input);
    });
    ipcMain.handle('backlog:update-highlight', (_event, input) => {
        return updateBacklogHighlight(input);
    });
    ipcMain.handle('backlog:add-or-update-link', (_event, input) => {
        return addOrUpdateBacklogLink(input);
    });
    ipcMain.handle('backlog:remove-link', (_event, input) => {
        return removeBacklogLink(input);
    });
    ipcMain.handle('backlog:update-module-metadata', (_event, input) => {
        return updateBacklogModuleMetadata(input);
    });
    ipcMain.handle('backlog:move-object-source', (_event, input) => {
        return moveBacklogObjectSource(input);
    });
    ipcMain.handle('backlog:remove-object-record', (_event, input) => {
        return removeBacklogObjectRecord(input);
    });
    ipcMain.handle('backlog:update-epic', (_event, input) => {
        return updateBacklogEpic(input);
    });
    ipcMain.handle('backlog:update-epic-color', (_event, input) => {
        return updateBacklogEpicColor(input);
    });
    ipcMain.handle('backlog:update-dependencies', (_event, input) => {
        return updateBacklogDependencies(input);
    });
    ipcMain.handle('backlog:update-mockups', (_event, input) => {
        return updateBacklogMockups(input);
    });
    ipcMain.handle('backlog:create-epic', (_event, input) => {
        return createBacklogEpic(input);
    });
}
