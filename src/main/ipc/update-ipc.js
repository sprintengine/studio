export function registerUpdateIpc(ipcMain, { updateService }) {
    ipcMain.handle('update:get-state', () => {
        return updateService.getState();
    });
    ipcMain.handle('update:check', async () => {
        return updateService.checkForUpdates(true);
    });
    ipcMain.handle('update:download', async () => {
        return updateService.downloadUpdate();
    });
    ipcMain.handle('update:quit-and-install', () => {
        return updateService.quitAndInstall();
    });
    ipcMain.handle('update:open-release-notes', async () => {
        return updateService.openReleaseNotes();
    });
}
