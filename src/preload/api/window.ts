import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ElectronApi, WindowState } from '../../shared/electron-api'

export const windowApi = {
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: (): Promise<WindowState | null> => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  getWindowState: (): Promise<WindowState | null> => ipcRenderer.invoke('window:get-state'),
  onWindowStateChanged: (cb: (state: WindowState) => void): (() => void) => {
    const ch = 'window:state-changed'
    const handler = (_: IpcRendererEvent, state: WindowState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  'windowMinimize' | 'windowToggleMaximize' | 'windowClose' | 'getWindowState' | 'onWindowStateChanged'
>
