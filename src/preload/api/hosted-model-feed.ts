import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  HostedModelFeedReadInput,
  HostedModelFeedReadResult,
  HostedSourcesFeedReadResult,
} from '../../shared/electron-api'

export const hostedModelFeedApi = {
  // The recommended sources the Extensions door offers. Disk-only by design —
  // the poller's feed leg is what refreshes it (MC-2519), so opening the door
  // never waits on GitHub.
  hostedSourcesFeedGet: (): Promise<HostedSourcesFeedReadResult> => ipcRenderer.invoke('hosted-sources-feed:get'),
  hostedModelFeedGet: (): Promise<HostedModelFeedReadResult> => ipcRenderer.invoke('hosted-model-feed:get'),
  hostedModelFeedRefresh: (
    input?: Pick<HostedModelFeedReadInput, 'forceRefresh'>,
  ): Promise<HostedModelFeedReadResult> => ipcRenderer.invoke('hosted-model-feed:refresh', input),
  onHostedModelFeedChanged: (cb: (result: HostedModelFeedReadResult) => void): (() => void) => {
    const ch = 'hosted-model-feed:changed'
    const handler = (_: IpcRendererEvent, result: HostedModelFeedReadResult): void => cb(result)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  'hostedSourcesFeedGet' | 'hostedModelFeedGet' | 'hostedModelFeedRefresh' | 'onHostedModelFeedChanged'
>
