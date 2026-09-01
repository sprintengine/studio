export function registerAuthIpc(ipcMain, auth, entitlements) {
    ipcMain.handle('auth:get-state', () => auth.initialize());
    ipcMain.handle('auth:login', (_, organizationId) => auth.login(organizationId));
    ipcMain.handle('auth:logout', () => auth.logout());
    ipcMain.handle('auth:refresh-entitlements', () => auth.refreshEntitlements({ forceRefresh: true }));
    ipcMain.handle('auth:select-organization', (_, organizationId) => auth.selectOrganization(organizationId));
    ipcMain.handle('auth:open-upgrade', (_, reason) => auth.openUpgrade(reason));
    ipcMain.handle('auth:check-premium-access', (_, input) => entitlements.checkAccess(input));
    ipcMain.handle('auth:get-session', () => auth.getSession());
    ipcMain.handle('auth:get-entitlements', (_, options) => entitlements.getSnapshot(options));
    ipcMain.handle('auth:require-entitlement', (_, input) => entitlements.requireFeature(input));
}
