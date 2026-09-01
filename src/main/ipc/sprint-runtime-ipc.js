export function registerSprintRuntimeIpc(ipcMain, deps) {
    ipcMain.handle('sprintengine:runtime:register-run', (_event, payload) => {
        deps.sprintRuntime.registerRun(payload);
        return { ok: true };
    });
    ipcMain.handle('sprintengine:runtime:unregister-run', (_event, payload) => {
        deps.sprintRuntime.unregisterRun(payload.statePath);
        return { ok: true };
    });
    ipcMain.handle('sprintengine:runtime:stop-reason', (_event, payload) => {
        deps.sprintRuntime.applyStopReason(payload);
        return { ok: true };
    });
    // Same-mode recovery (the board's Resume control): re-enter `running`
    // without a mode change and wake the scheduler.
    ipcMain.handle('sprintengine:runtime:resume', (_event, payload) => {
        deps.sprintRuntime.applyResume(payload.statePath);
        return { ok: true };
    });
}
