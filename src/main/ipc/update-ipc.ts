import type { IpcMain } from 'electron'
import type { AppUpdateCheckResult, AppUpdateState } from '../../shared/electron-api'
import type { SprintEngineUpdateService } from '../update-service'

type UpdateIpcDependencies = {
  updateService: SprintEngineUpdateService
}

export function registerUpdateIpc(ipcMain: IpcMain, { updateService }: UpdateIpcDependencies): void {
  ipcMain.handle('update:get-state', (): AppUpdateState => {
    return updateService.getState()
  })

  ipcMain.handle('update:check', async (): Promise<AppUpdateCheckResult> => {
    return updateService.checkForUpdates(true)
  })

  ipcMain.handle('update:download', async (): Promise<AppUpdateCheckResult> => {
    return updateService.downloadUpdate()
  })

  ipcMain.handle('update:quit-and-install', (): AppUpdateCheckResult => {
    return updateService.quitAndInstall()
  })

  ipcMain.handle('update:open-release-notes', async (): Promise<{ opened: true; url: string }> => {
    return updateService.openReleaseNotes()
  })
}
