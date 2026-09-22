import type { IpcMain } from 'electron'
import type { AppUpdateChannelSetting, AppUpdateCheckResult, AppUpdateState } from '../../shared/electron-api'
import { isUpdateTrack } from '../update-channel-store'
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

  ipcMain.handle('update:get-channel', (): AppUpdateChannelSetting => {
    return updateService.getChannel()
  })

  ipcMain.handle('update:set-channel', async (_event, channel: unknown): Promise<AppUpdateCheckResult> => {
    if (!isUpdateTrack(channel)) throw new Error(`Unknown update channel: ${String(channel)}`)
    return updateService.setChannel(channel)
  })

  ipcMain.handle('update:open-release-notes', async (): Promise<{ opened: true; url: string }> => {
    return updateService.openReleaseNotes()
  })
}
