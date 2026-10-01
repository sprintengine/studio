import { ipcRenderer } from 'electron'
import type { ElectronApi, HostedSourcesFeedReadResult } from '../../shared/electron-api'

export const hostedSourcesFeedApi = {
  // The recommended sources the Extensions door offers. Disk-only by design —
  // the poller's feed leg is what refreshes it, so opening the door
  // never waits on GitHub.
  hostedSourcesFeedGet: (): Promise<HostedSourcesFeedReadResult> => ipcRenderer.invoke('hosted-sources-feed:get'),
} satisfies Pick<ElectronApi, 'hostedSourcesFeedGet'>
