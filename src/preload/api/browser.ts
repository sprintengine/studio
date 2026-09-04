import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BrowserCaptureInput,
  BrowserClearResult,
  BrowserConfig,
  BrowserHostKey,
  BrowserPointerEvent,
  BrowserRegisterInput,
  BrowserRegisterResult,
  BrowserScreenshotResult,
  BrowserTabState,
  LocalServer,
} from '../../shared/browser'
import type { BrowserColorScheme, BrowserViewport } from '../../shared/browser-devices'
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
  browserZoomStep: (tabId: string, direction: 1 | -1 | 0): Promise<boolean> =>
    ipcRenderer.invoke('browser:zoom-step', { tabId, direction }),
  browserSetColorScheme: (tabId: string, scheme: BrowserColorScheme): Promise<boolean> =>
    ipcRenderer.invoke('browser:set-color-scheme', { tabId, scheme }),
  browserOpenDevTools: (tabId: string): Promise<boolean> => ipcRenderer.invoke('browser:open-devtools', { tabId }),
  browserOpenWindow: (tabId: string): Promise<boolean> => ipcRenderer.invoke('browser:open-window', { tabId }),
  browserClearCookies: (): Promise<BrowserClearResult> => ipcRenderer.invoke('browser:clear-cookies'),
  browserClearCache: (): Promise<BrowserClearResult> => ipcRenderer.invoke('browser:clear-cache'),
  browserCapture: (input: BrowserCaptureInput): Promise<BrowserScreenshotResult> =>
    ipcRenderer.invoke('browser:capture', input),
  browserCopyScreenshot: (tabId: string): Promise<BrowserClearResult> =>
    ipcRenderer.invoke('browser:copy-screenshot', { tabId }),
  browserLocalServers: (workspaceId: string): Promise<LocalServer[]> =>
    ipcRenderer.invoke('browser:local-servers', { workspaceId }),
  browserNoteActive: (workspaceId: string, tabId: string | null): Promise<void> =>
    ipcRenderer.invoke('browser:note-active', { workspaceId, tabId }),
  onBrowserOpenRequest: (cb: (payload: { workspaceId: string; url: string | null; tabId: string | null }) => void): (() => void) =>
    subscribe('browser:open-request', cb),
  onBrowserPointer: (cb: (event: BrowserPointerEvent) => void): (() => void) => subscribe('browser:pointer', cb),
  onBrowserViewportRequest: (cb: (payload: { tabId: string; viewport: BrowserViewport }) => void): (() => void) =>
    subscribe('browser:viewport-request', cb),
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
  | 'browserZoomStep'
  | 'browserSetColorScheme'
  | 'browserOpenDevTools'
  | 'browserOpenWindow'
  | 'browserClearCookies'
  | 'browserClearCache'
  | 'browserCapture'
  | 'browserCopyScreenshot'
  | 'browserLocalServers'
  | 'browserNoteActive'
  | 'onBrowserOpenRequest'
  | 'onBrowserPointer'
  | 'onBrowserViewportRequest'
  | 'onBrowserState'
  | 'onBrowserFocusUrl'
  | 'onBrowserHostKey'
>
