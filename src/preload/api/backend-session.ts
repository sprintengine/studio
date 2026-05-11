import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BackendSessionAttachResult,
  BackendSessionListResult,
  BackendSessionSignal,
  ElectronApi,
} from '../../shared/electron-api'

export const backendSessionApi = {
  listBackendSessions: (workspaceRoot: string): Promise<BackendSessionListResult> =>
    ipcRenderer.invoke('backend-session:list', workspaceRoot),
  attachBackendSession: (args: {
    workspaceRoot: string
    executionId: string
    instanceKey: string
  }): Promise<BackendSessionAttachResult> => ipcRenderer.invoke('backend-session:attach', args),
  detachBackendSession: (instanceKey: string): Promise<void> =>
    ipcRenderer.invoke('backend-session:detach', instanceKey),
  writeBackendSession: (args: {
    workspaceRoot: string
    executionId: string
    data: string
  }): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('backend-session:write', args),
  resizeBackendSession: (args: {
    workspaceRoot: string
    executionId: string
    cols: number
    rows: number
  }): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('backend-session:resize', args),
  signalBackendSession: (args: {
    workspaceRoot: string
    executionId: string
    signal: BackendSessionSignal
  }): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('backend-session:signal', args),
  onBackendSessionReplay: (instanceKey: string, cb: (payload: { data: string }) => void): (() => void) => {
    const ch = `backend-session:replay:${instanceKey}`
    const handler = (_: IpcRendererEvent, payload: { data: string }): void => cb(payload)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onBackendSessionData: (instanceKey: string, cb: (payload: { data: string }) => void): (() => void) => {
    const ch = `backend-session:data:${instanceKey}`
    const handler = (_: IpcRendererEvent, payload: { data: string }): void => cb(payload)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onBackendSessionExit: (
    instanceKey: string,
    cb: (payload: { exitCode: number | null; exitedAt?: string | null; reason?: string }) => void,
  ): (() => void) => {
    const ch = `backend-session:exit:${instanceKey}`
    const handler = (
      _: IpcRendererEvent,
      payload: { exitCode: number | null; exitedAt?: string | null; reason?: string },
    ): void => cb(payload)
    ipcRenderer.once(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onBackendSessionError: (instanceKey: string, cb: (payload: { message: string }) => void): (() => void) => {
    const ch = `backend-session:error:${instanceKey}`
    const handler = (_: IpcRendererEvent, payload: { message: string }): void => cb(payload)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'listBackendSessions'
  | 'attachBackendSession'
  | 'detachBackendSession'
  | 'writeBackendSession'
  | 'resizeBackendSession'
  | 'signalBackendSession'
  | 'onBackendSessionReplay'
  | 'onBackendSessionData'
  | 'onBackendSessionExit'
  | 'onBackendSessionError'
>
