import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ElectronApi, SplashProgress } from '../../shared/electron-api'

// The splash window's only channel pair. It loads this same preload — that is
// the one thing it shares with the app — but never the React bundle, since the
// bundle load is the gap the splash exists to cover.
export const splashApi = {
  onSplashProgress: (cb: (update: SplashProgress) => void): (() => void) => {
    const ch = 'splash:progress'
    const handler = (_: IpcRendererEvent, update: SplashProgress) => cb(update)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  // Fire-and-forget `send`, not `invoke`: main answers by revealing the window,
  // and a renderer awaiting a reply it does not need is one more way for boot to
  // wedge.
  notifyBootComplete: (): void => {
    ipcRenderer.send('app:boot-complete')
  },
} satisfies Pick<ElectronApi, 'onSplashProgress' | 'notifyBootComplete'>
