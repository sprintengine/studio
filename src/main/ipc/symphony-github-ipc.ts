import type { IpcMain } from 'electron'
import { syncGitHubIssuesIntoSprintEngineTasks } from '../symphony-github'

type IpcDiagnostics = {
  withIpcDiagnostics<T>(
    scope: string,
    event: string,
    payload: Record<string, unknown>,
    action: () => Promise<T>
  ): Promise<T>
}

export function registerSymphonyGitHubIpc(ipcMain: IpcMain, diagnostics: IpcDiagnostics): void {
  ipcMain.handle('symphony:github:sync-issues', async (_, input) => {
    return diagnostics.withIpcDiagnostics(
      'SymphonyGitHubIPC',
      'sync-issues',
      {
        repoRoot: input?.repoRoot,
        statePath: input?.statePath,
        hasToken: Boolean(input?.token),
      },
      () => syncGitHubIssuesIntoSprintEngineTasks(input)
    )
  })
}
