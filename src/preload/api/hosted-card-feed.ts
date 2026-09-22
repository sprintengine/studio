import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CardRunInput,
  CardRunResult,
  ElectronApi,
  HostedCardFeedReadInput,
  HostedCardFeedReadResult,
} from '../../shared/electron-api'

// The card feed's get, refresh and changed channels — plus
// `cards:run`, which is the one that does something rather than reads
// something. It rides here rather than in a file of its own because Go is the
// card's own verb and the feed is where the card came from (item 2469).
// `onHostedCardFeedChanged` returns the unsubscribe rather than relying on the
// caller to remember the handler: the home page mounts and unmounts with the
// Extensions door, and a listener left behind on every open would push a feed
// into a component that is no longer on screen.
//
// `hostedCardFeedRefresh` has NO renderer caller today, and that is the state
// this file was left in on purpose (2026-09-06,
// backlog/2026-09-06-the-seams-that-lead-nowhere.md §1). The store's refresh
// action was removed — nothing in the app pressed it — but the binding stays,
// because `ElectronApi` declares the channel and this is where its renderer
// half lives; deleting it here would leave the contract naming a call the
// bridge does not make. The fetching that actually happens is the hourly poller
// in app-lifecycle.ts, which reaches `readHostedCardFeed` from main and comes
// back through `hosted-card-feed:changed`.
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
