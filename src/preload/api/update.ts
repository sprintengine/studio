import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppUpdateChannelSetting,
  AppUpdateCheckResult,
  AppUpdateState,
  AppUpdateTrack,
  ElectronApi,
} from '../../shared/electron-api'

export const updateApi = {
  updateGetState: (): Promise<AppUpdateState> => ipcRenderer.invoke('update:get-state'),
  updateCheck: (): Promise<AppUpdateCheckResult> => ipcRenderer.invoke('update:check'),
  updateDownload: (): Promise<AppUpdateCheckResult> => ipcRenderer.invoke('update:download'),
  updateQuitAndInstall: (): Promise<AppUpdateCheckResult> => ipcRenderer.invoke('update:quit-and-install'),
  updateOpenReleaseNotes: (): Promise<{ opened: true; url: string }> => ipcRenderer.invoke('update:open-release-notes'),
  updateGetChannel: (): Promise<AppUpdateChannelSetting> => ipcRenderer.invoke('update:get-channel'),
  updateSetChannel: (channel: AppUpdateTrack): Promise<AppUpdateCheckResult> =>
    ipcRenderer.invoke('update:set-channel', channel),
  onUpdateStateChanged: (cb: (state: AppUpdateState) => void): (() => void) => {
    const ch = 'update:state-changed'
    const handler = (_: IpcRendererEvent, state: AppUpdateState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'updateGetState'
  | 'updateCheck'
  | 'updateDownload'
  | 'updateQuitAndInstall'
  | 'updateOpenReleaseNotes'
  | 'updateGetChannel'
  | 'updateSetChannel'
  | 'onUpdateStateChanged'
>
