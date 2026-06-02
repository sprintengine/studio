import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CreateWorkspaceWindowInput,
  CreateWorkspaceWindowResult,
  ElectronApi,
  WindowPlacement,
  WindowState,
} from '../../shared/electron-api'

export const windowApi = {
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: (): Promise<WindowState | null> => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  getWindowState: (): Promise<WindowState | null> => ipcRenderer.invoke('window:get-state'),
  getWindowPlacement: (): Promise<WindowPlacement | null> => ipcRenderer.invoke('window:get-placement'),
  getWorkspaceWindowId: (): Promise<string> => ipcRenderer.invoke('window:get-workspace-window-id'),
  createWorkspaceWindow: (input: CreateWorkspaceWindowInput): Promise<CreateWorkspaceWindowResult> =>
    ipcRenderer.invoke('window:create-workspace-window', input),
  confirmWindowClose: (): Promise<void> => ipcRenderer.invoke('window:confirm-close'),
  onWindowStateChanged: (cb: (state: WindowState) => void): (() => void) => {
    const ch = 'window:state-changed'
    const handler = (_: IpcRendererEvent, state: WindowState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onWindowPlacementChanged: (cb: (placement: WindowPlacement) => void): (() => void) => {
    const ch = 'window:placement-changed'
    const handler = (_: IpcRendererEvent, placement: WindowPlacement) => cb(placement)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onWindowCloseRequested: (cb: () => void): (() => void) => {
    const ch = 'window:close-requested'
    const handler = () => cb()
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'windowMinimize'
  | 'windowToggleMaximize'
  | 'windowClose'
  | 'getWindowState'
  | 'getWindowPlacement'
  | 'getWorkspaceWindowId'
  | 'createWorkspaceWindow'
  | 'confirmWindowClose'
  | 'onWindowStateChanged'
  | 'onWindowPlacementChanged'
  | 'onWindowCloseRequested'
>
