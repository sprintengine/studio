export function registerAgentConfigImportIpc(ipcMain, service) {
    ipcMain.handle('agent-config:detect', (_, input) => service.detect(input));
    ipcMain.handle('agent-config:adopt', (_, input) => service.adopt(input));
}
