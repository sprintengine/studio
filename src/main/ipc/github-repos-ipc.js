import { listGitHubRepos } from '../github-repos';
import { cloneGitHubRepo } from '../git-clone';
// The clone picker's two calls. The token never crosses IPC: both handlers
// resolve it from the store on this side, and the renderer only ever sees
// repo metadata and clone outcomes.
export function registerGitHubReposIpc(ipcMain, githubTokenStore) {
    ipcMain.handle('github:list-repos', () => listGitHubRepos(githubTokenStore));
    ipcMain.handle('github:clone', async (_, input) => {
        const request = input;
        if (!request
            || typeof request.url !== 'string'
            || typeof request.parentDir !== 'string'
            || typeof request.folderName !== 'string') {
            return { ok: false, message: 'Invalid clone request.' };
        }
        const token = await githubTokenStore.resolveToken();
        return cloneGitHubRepo({
            url: request.url,
            parentDir: request.parentDir,
            folderName: request.folderName,
            token,
        });
    });
}
