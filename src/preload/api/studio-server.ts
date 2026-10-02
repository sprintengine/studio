import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type { ServerMode } from '../../shared/server-mode'
import {
  STUDIO_SERVER_CHANNELS,
  type StudioServerInfo,
  type StudioServerStatus,
} from '../../shared/studio-server-status'

// The Studio server as the shell sees it: its phase in words, the Advanced
// toggle, and the actions a person takes on it. Shell-owned channels: they
// answer whether or not the server is running.
export const studioServerApi = {
  studioServerStatus: (): Promise<StudioServerStatus> => ipcRenderer.invoke(STUDIO_SERVER_CHANNELS.status),
  studioServerInfo: (): Promise<StudioServerInfo | null> => ipcRenderer.invoke(STUDIO_SERVER_CHANNELS.info),
  studioServerRetry: (): Promise<void> => ipcRenderer.invoke(STUDIO_SERVER_CHANNELS.retry),
  studioServerRestart: (): Promise<void> => ipcRenderer.invoke(STUDIO_SERVER_CHANNELS.restart),
  studioServerOpenLog: (): Promise<boolean> => ipcRenderer.invoke(STUDIO_SERVER_CHANNELS.openLog),
  studioServerSetMode: (mode: ServerMode): Promise<StudioServerStatus> =>
    ipcRenderer.invoke(STUDIO_SERVER_CHANNELS.setMode, mode),
  studioServerRelaunch: (options: { compatibility?: boolean } = {}): Promise<void> =>
    ipcRenderer.invoke(STUDIO_SERVER_CHANNELS.relaunch, options),
  onStudioServerStatus: (cb: (status: StudioServerStatus) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, status: StudioServerStatus) => cb(status)
    ipcRenderer.on(STUDIO_SERVER_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(STUDIO_SERVER_CHANNELS.changed, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'studioServerStatus'
  | 'studioServerInfo'
  | 'studioServerRetry'
  | 'studioServerRestart'
  | 'studioServerOpenLog'
  | 'studioServerSetMode'
  | 'studioServerRelaunch'
  | 'onStudioServerStatus'
>
