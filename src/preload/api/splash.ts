import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'

// The app window's half of the splash handshake. The plate itself loads its own
// one-channel preload (`src/preload/splash.ts`), never this one.
export const splashApi = {
  // Fire-and-forget `send`, not `invoke`: main answers by revealing the window,
  // and a renderer awaiting a reply it does not need is one more way for boot to
  // wedge.
  notifyBootComplete: (): void => {
    ipcRenderer.send('app:boot-complete')
  },
} satisfies Pick<ElectronApi, 'notifyBootComplete'>
