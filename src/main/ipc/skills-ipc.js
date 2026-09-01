export function registerSkillsIpc(ipcMain, service) {
    ipcMain.handle('skills:list-sources', () => service.listSources());
    ipcMain.handle('skills:add-source', (_, input) => service.addSource(input));
    ipcMain.handle('skills:remove-source', (_, input) => service.removeSource(input));
    ipcMain.handle('skills:scan', (_, input) => service.getScan(input));
    ipcMain.handle('skills:read-file', (_, input) => service.readFile(input));
    ipcMain.handle('skills:install', (_, input) => service.install(input));
    ipcMain.handle('skills:uninstall', (_, input) => service.uninstall(input));
    ipcMain.handle('skills:sync-source', (_, input) => service.syncSource(input));
    ipcMain.handle('skills:search', (_, input) => service.search(input));
    ipcMain.handle('skills:list-popular-repos', () => service.listPopularRepos());
}
