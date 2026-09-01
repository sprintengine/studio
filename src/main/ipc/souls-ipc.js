export function registerSoulsIpc(ipcMain, deps) {
    ipcMain.handle('souls:read-specialist', async (_, specialistId) => {
        return deps.readSpecialistSoul(specialistId);
    });
}
