import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppUpdateCheckResult, AppUpdateState, ElectronApi } from '../../shared/electron-api'

export const updateApi = {
  updateGetState: (): Promise<AppUpdateState> => ipcRenderer.invoke('update:get-state'),
  updateCheck: (): Promise<AppUpdateCheckResult> => ipcRenderer.invoke('update:check'),
  updateDownload: (): Promise<AppUpdateCheckResult> => ipcRenderer.invoke('update:download'),
  updateQuitAndInstall: (): Promise<AppUpdateCheckResult> => ipcRenderer.invoke('update:quit-and-install'),
  updateOpenReleaseNotes: (): Promise<{ opened: true; url: string }> =>
    ipcRenderer.invoke('update:open-release-notes'),
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
  | 'onUpdateStateChanged'
>
