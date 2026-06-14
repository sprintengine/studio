import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AuxWindowRetargetPayload,
  CreateWorkspaceWindowInput,
  CreateWorkspaceWindowResult,
  ElectronApi,
  OpenAuxWindowInput,
  OpenAuxWindowResult,
  OpenExternalResult,
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
  openAuxWindow: (input: OpenAuxWindowInput): Promise<OpenAuxWindowResult> =>
    ipcRenderer.invoke('window:open-aux-window', input),
  onAuxWindowRetarget: (cb: (payload: AuxWindowRetargetPayload) => void): (() => void) => {
    const ch = 'aux:retarget'
    const handler = (_: IpcRendererEvent, payload: AuxWindowRetargetPayload) => cb(payload)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  confirmWindowClose: (): Promise<void> => ipcRenderer.invoke('window:confirm-close'),
  openExternal: (url: string): Promise<OpenExternalResult> =>
    ipcRenderer.invoke('window:open-external', url),
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
  | 'openAuxWindow'
  | 'onAuxWindowRetarget'
  | 'confirmWindowClose'
  | 'openExternal'
  | 'onWindowStateChanged'
  | 'onWindowPlacementChanged'
  | 'onWindowCloseRequested'
>
