export function registerMobileBridgeIpc(ipcMain, deps) {
    ipcMain.handle('mobile-bridge:get-state', () => deps.bridge.getState());
    ipcMain.handle('mobile-bridge:update-settings', (_, input) => {
        return deps.bridge.updateSettings(input);
    });
    ipcMain.handle('mobile-bridge:request-pairing-code', () => deps.bridge.requestPairingCode());
    ipcMain.handle('mobile-bridge:list-devices', () => deps.bridge.listDevices());
    ipcMain.handle('mobile-bridge:revoke-device', (_, deviceId, reason) => {
        return deps.bridge.revokeDevice(deviceId, reason);
    });
    ipcMain.handle('mobile-bridge:publish-presence', (_, presence) => {
        return deps.bridge.publishPresence(presence);
    });
    ipcMain.handle('mobile-bridge:get-diagnostics', () => deps.bridge.getDiagnostics());
}
