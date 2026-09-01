import type { IpcMain } from 'electron'
import type { GitHubTokenStore } from '../github-token-store'
import type { GitHubCloneInput } from '../../shared/electron-api'
import { listGitHubRepos } from '../github-repos'
import { cloneGitHubRepo } from '../git-clone'

// The clone picker's two calls. The token never crosses IPC: both handlers
// resolve it from the store on this side, and the renderer only ever sees
// repo metadata and clone outcomes.
export function registerGitHubReposIpc(ipcMain: IpcMain, githubTokenStore: GitHubTokenStore): void {
  ipcMain.handle('github:list-repos', () => listGitHubRepos(githubTokenStore))

  ipcMain.handle('github:clone', async (_, input: unknown) => {
    const request = input as Partial<GitHubCloneInput> | null
    if (
      !request
      || typeof request.url !== 'string'
      || typeof request.parentDir !== 'string'
      || typeof request.folderName !== 'string'
    ) {
      return { ok: false as const, message: 'Invalid clone request.' }
    }
    const token = await githubTokenStore.resolveToken()
    return cloneGitHubRepo({
      url: request.url,
      parentDir: request.parentDir,
      folderName: request.folderName,
      token,
    })
  })
}
