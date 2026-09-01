export function registerGitHubTokenIpc(ipcMain, githubTokenStore) {
    ipcMain.handle('github:token-status', () => githubTokenStore.getStatus());
    ipcMain.handle('github:set-token', async (_, token) => {
        if (typeof token !== 'string') {
            throw new Error('GitHub token must be a string.');
        }
        return githubTokenStore.writeToken(token);
    });
    ipcMain.handle('github:clear-token', () => githubTokenStore.clearToken());
}
