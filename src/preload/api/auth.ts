import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ElectronApi, SprintEngineAuthState } from '../../shared/electron-api'

export const authApi = {
  authGetState: (): Promise<SprintEngineAuthState> => ipcRenderer.invoke('auth:get-state'),
  authLogin: (organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }> =>
    ipcRenderer.invoke('auth:login', organizationId),
  authLogout: (): Promise<{ loggedOut: true }> => ipcRenderer.invoke('auth:logout'),
  authRefreshEntitlements: (): Promise<SprintEngineAuthState> => ipcRenderer.invoke('auth:refresh-entitlements'),
  authOpenUpgrade: (reason?: string): Promise<{ opened: true; url: string }> =>
    ipcRenderer.invoke('auth:open-upgrade', reason),
  onAuthStateChanged: (cb: (state: SprintEngineAuthState) => void): (() => void) => {
    const ch = 'auth:state-changed'
    const handler = (_: IpcRendererEvent, state: SprintEngineAuthState) => cb(state)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onAuthCallbackError: (cb: (message: string) => void): (() => void) => {
    const ch = 'auth:callback-error'
    const handler = (_: IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'authGetState'
  | 'authLogin'
  | 'authLogout'
  | 'authRefreshEntitlements'
  | 'authOpenUpgrade'
  | 'onAuthStateChanged'
  | 'onAuthCallbackError'
>
