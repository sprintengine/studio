export function registerWorkspaceBackupIpc(ipcMain, backup) {
    ipcMain.handle('workspace-backup:write', async (_event, payload) => {
        if (!payload || typeof payload !== 'object') {
            return { ok: false, message: 'invalid_payload' };
        }
        return backup.write(payload);
    });
    ipcMain.handle('workspace-backup:read', () => backup.read());
}
