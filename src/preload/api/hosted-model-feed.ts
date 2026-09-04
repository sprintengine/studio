import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ElectronApi, HostedModelFeedReadInput, HostedModelFeedReadResult } from '../../shared/electron-api'

export const hostedModelFeedApi = {
  hostedModelFeedGet: (): Promise<HostedModelFeedReadResult> => ipcRenderer.invoke('hosted-model-feed:get'),
  hostedModelFeedRefresh: (input?: Pick<HostedModelFeedReadInput, 'forceRefresh'>): Promise<HostedModelFeedReadResult> =>
    ipcRenderer.invoke('hosted-model-feed:refresh', input),
  onHostedModelFeedChanged: (cb: (result: HostedModelFeedReadResult) => void): (() => void) => {
    const ch = 'hosted-model-feed:changed'
    const handler = (_: IpcRendererEvent, result: HostedModelFeedReadResult): void => cb(result)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<ElectronApi, 'hostedModelFeedGet' | 'hostedModelFeedRefresh' | 'onHostedModelFeedChanged'>
