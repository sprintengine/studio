import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CardRunInput,
  CardRunResult,
  ElectronApi,
  HostedCardFeedReadInput,
  HostedCardFeedReadResult,
} from '../../shared/electron-api'

// The card feed's channels, the model feed's three channels' siblings — plus
// `cards:run`, which is the one that does something rather than reads
// something. It rides here rather than in a file of its own because Go is the
// card's own verb and the feed is where the card came from (item 2469).
// `onHostedCardFeedChanged` returns the unsubscribe rather than relying on the
// caller to remember the handler: the home page mounts and unmounts with the
// Extensions door, and a listener left behind on every open would push a feed
// into a component that is no longer on screen.
export const hostedCardFeedApi = {
  hostedCardFeedGet: (): Promise<HostedCardFeedReadResult> => ipcRenderer.invoke('hosted-card-feed:get'),
  hostedCardFeedRefresh: (input?: Pick<HostedCardFeedReadInput, 'forceRefresh'>): Promise<HostedCardFeedReadResult> =>
    ipcRenderer.invoke('hosted-card-feed:refresh', input),
  onHostedCardFeedChanged: (cb: (result: HostedCardFeedReadResult) => void): (() => void) => {
    const ch = 'hosted-card-feed:changed'
    const handler = (_: IpcRendererEvent, result: HostedCardFeedReadResult): void => cb(result)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  cardsRun: (input: CardRunInput): Promise<CardRunResult> => ipcRenderer.invoke('cards:run', input),
} satisfies Pick<ElectronApi, 'hostedCardFeedGet' | 'hostedCardFeedRefresh' | 'onHostedCardFeedChanged' | 'cardsRun'>
