import type { IpcMain } from 'electron'
import { syncGitHubIssuesIntoSprintEngineTasks, writeBackGitHubIssueProgress } from '../symphony-github'
import type { GitHubTokenStore } from '../github-token-store'

type IpcDiagnostics = {
  withIpcDiagnostics<T>(
    scope: string,
    event: string,
    payload: Record<string, unknown>,
    action: () => Promise<T>
  ): Promise<T>
}

type SymphonyGitHubIpcDependencies = IpcDiagnostics & {
  githubTokenStore: GitHubTokenStore
}

export function registerSymphonyGitHubIpc(ipcMain: IpcMain, deps: SymphonyGitHubIpcDependencies): void {
  ipcMain.handle('symphony:github:token-status', () => deps.githubTokenStore.getStatus())

  ipcMain.handle('symphony:github:set-token', async (_, token: unknown) => {
    if (typeof token !== 'string') throw new Error('GitHub token must be a string.')
    return deps.githubTokenStore.writeToken(token)
  })

  ipcMain.handle('symphony:github:clear-token', () => deps.githubTokenStore.clearToken())

  ipcMain.handle('symphony:github:sync-issues', async (_, input) => {
    const tokenStatus = await deps.githubTokenStore.getStatus()
    return deps.withIpcDiagnostics(
      'SymphonyGitHubIPC',
      'sync-issues',
      {
        repoRoot: input?.repoRoot,
        statePath: input?.statePath,
        hasToken: Boolean(input?.token) || tokenStatus.configured,
      },
      async () => syncGitHubIssuesIntoSprintEngineTasks({
        ...input,
        token: await deps.githubTokenStore.resolveToken(input?.token),
      })
    )
  })

  ipcMain.handle('symphony:github:write-back', async (_, input) => {
    const tokenStatus = await deps.githubTokenStore.getStatus()
    return deps.withIpcDiagnostics(
      'SymphonyGitHubIPC',
      'write-back',
      {
        repoRoot: input?.repoRoot,
        statePath: input?.statePath,
        taskId: input?.taskId,
        kind: input?.kind,
        hasToken: Boolean(input?.token) || tokenStatus.configured,
      },
      async () => writeBackGitHubIssueProgress({
        ...input,
        token: await deps.githubTokenStore.resolveToken(input?.token),
      })
    )
  })
}
