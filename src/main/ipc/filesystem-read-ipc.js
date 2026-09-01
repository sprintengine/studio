export function registerFilesystemReadIpc(ipcMain, deps) {
    ipcMain.handle('fs:readdir', async (_, dirPath) => {
        return deps.readDirectory(dirPath);
    });
    ipcMain.handle('fs:readfile', async (_, filePath) => {
        return deps.readTextFile(filePath);
    });
    ipcMain.handle('fs:read-image-data-url', async (_, filePath) => {
        return deps.readImageDataUrl(filePath);
    });
    ipcMain.handle('fs:path-exists', async (_, targetPath) => {
        return deps.pathExists(targetPath);
    });
    ipcMain.handle('fs:stat', async (_, targetPath) => {
        return deps.statPath(targetPath);
    });
    ipcMain.handle('fs:check-workspace-folder', async (_, targetPath) => {
        return deps.checkWorkspaceFolder(targetPath);
    });
    ipcMain.handle('fs:detect-project-logo', async (_, folderPath) => {
        return deps.detectProjectLogo(folderPath);
    });
    ipcMain.handle('fs:show-item-in-folder', async (_, targetPath) => {
        await deps.showItemInFolder(targetPath);
    });
    ipcMain.handle('fs:open-html-file-in-browser', async (_, targetPath) => {
        await deps.openHtmlFileInBrowser(targetPath);
    });
}
