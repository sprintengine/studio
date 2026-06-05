import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppMenuAcceleratorUpdate, ElectronApi } from '../../shared/electron-api'

export const appMenuApi = {
  onAppMenuCommand: (cb: (command: string) => void): (() => void) => {
    const ch = 'app-menu:command'
    const handler = (_: IpcRendererEvent, command: string) => cb(command)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  updateAppMenuAccelerators: (updates: AppMenuAcceleratorUpdate[]) =>
    ipcRenderer.invoke('app-menu:update-accelerators', updates),
} satisfies Pick<ElectronApi, 'onAppMenuCommand' | 'updateAppMenuAccelerators'>
