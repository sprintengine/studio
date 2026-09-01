export function registerBuiltinSkillsIpc(ipcMain, handlers) {
    ipcMain.handle('builtin-skills:list', async () => handlers.list());
    ipcMain.handle('builtin-skills:status', async (_, input) => handlers.getStatus(input?.workspaceRoot ?? null, input?.skillId ?? ''));
    ipcMain.handle('builtin-skills:install', async (_, input) => handlers.install(input?.workspaceRoot ?? null, input?.skillId ?? ''));
}
