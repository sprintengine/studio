import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BrowserConfig,
  BrowserHostKey,
  BrowserRegisterInput,
  BrowserRegisterResult,
  BrowserTabState,
  LocalServer,
} from '../../shared/browser'
import type { ElectronApi } from '../../shared/electron-api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

export const browserApi = {
  browserConfig: (): Promise<BrowserConfig> => ipcRenderer.invoke('browser:config'),
  browserRegister: (input: BrowserRegisterInput): Promise<BrowserRegisterResult> =>
    ipcRenderer.invoke('browser:register', input),
  browserUnregister: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:unregister', { tabId }),
  browserState: (tabId: string): Promise<BrowserTabState | null> => ipcRenderer.invoke('browser:state', { tabId }),
  browserNavigate: (tabId: string, url: string): Promise<boolean> =>
    ipcRenderer.invoke('browser:navigate', { tabId, url }),
  browserBack: (tabId: string): Promise<boolean> => ipcRenderer.invoke('browser:back', { tabId }),
  browserForward: (tabId: string): Promise<boolean> => ipcRenderer.invoke('browser:forward', { tabId }),
  browserReload: (tabId: string, ignoreCache = false): Promise<boolean> =>
    ipcRenderer.invoke('browser:reload', { tabId, ignoreCache }),
  browserStop: (tabId: string): Promise<boolean> => ipcRenderer.invoke('browser:stop', { tabId }),
  browserOpenExternal: (tabId: string): Promise<{ ok: true } | { ok: false; message: string }> =>
    ipcRenderer.invoke('browser:open-external', { tabId }),
  browserLocalServers: (workspaceId: string): Promise<LocalServer[]> =>
    ipcRenderer.invoke('browser:local-servers', { workspaceId }),
  onBrowserState: (cb: (state: BrowserTabState) => void): (() => void) => subscribe('browser:state', cb),
  onBrowserFocusUrl: (cb: (payload: { tabId: string }) => void): (() => void) =>
    subscribe('browser:focus-url', cb),
  onBrowserHostKey: (cb: (payload: { tabId: string; key: BrowserHostKey }) => void): (() => void) =>
    subscribe('browser:host-key', cb),
} satisfies Pick<
  ElectronApi,
  | 'browserConfig'
  | 'browserRegister'
  | 'browserUnregister'
  | 'browserState'
  | 'browserNavigate'
  | 'browserBack'
  | 'browserForward'
  | 'browserReload'
  | 'browserStop'
  | 'browserOpenExternal'
  | 'browserLocalServers'
  | 'onBrowserState'
  | 'onBrowserFocusUrl'
  | 'onBrowserHostKey'
>
