export function registerMcpIpc(ipcMain, service) {
    ipcMain.handle('mcp:catalog', () => service.listCatalog());
    ipcMain.handle('mcp:preview-sync', (_, input) => service.previewSync(input));
    ipcMain.handle('mcp:sync', (_, input) => service.sync(input));
}
