import type { HostedCardFeedReadResult } from '../../../../shared/electron-api'
import type { HostedCard } from '../../../../shared/hosted-card-feed'

// The hosted card feed as the renderer sees it, the model feed slice's sibling
// and not a generalisation of it — the two feeds have different schemas and are
// free to drift, and a shared slice would make one feed's change the other
// feed's problem. Not persisted: the main process owns the cache on disk and
// serves it at boot, so a stale renderer copy cannot outlive the file.
//
// `cards` is the last GOOD feed and never anything else. A read that failed
// records why in `cardFeedError` and leaves the rows alone, because the
// Extensions home does not apologise for its own network (epic ruling R6) and
// blanking a page of cards because GitHub was slow is exactly that apology.
export interface HostedCardFeedSliceState {
  cards: HostedCard[]
  // `'error'` does not mean "nothing to draw". It means the last READ failed,
  // and `cards` still holds the last good feed — so a consumer writing
  // `status === 'error' ? <Empty/> : <Cards/>` blanks a full page the first
  // time the machine is offline, which is the apology R6 forbids. Draw the
  // cards; `cards.length` is what says whether there is a page.
  cardFeedStatus: 'idle' | 'loading' | 'ready' | 'error'
  // Why the last read failed, kept for diagnostics. The home page reads the
  // cards, not this.
  cardFeedError: string | null
}

export interface HostedCardFeedSliceActions {
  // First paint: what is on disk, no network. Never throws; a missing api is a
  // no-op, which is what a test renderer and a detached tool window are.
  loadCards: () => Promise<void>
  // A deliberate re-read. The main process pushes `hosted-card-feed:changed`
  // when the feed differs, but the result is applied here too so the caller's
  // own copy is current at once.
  refreshCards: (options?: { force?: boolean }) => Promise<HostedCardFeedReadResult | null>
  // The push handler. Also what tests drive directly.
  applyHostedCardFeedResult: (result: HostedCardFeedReadResult) => void
}

export type HostedCardFeedSlice = HostedCardFeedSliceState & HostedCardFeedSliceActions

type HostedCardFeedSliceSet = (mutator: (state: HostedCardFeedSliceState) => void) => void

type HostedCardFeedApi = Pick<Window['api'], 'hostedCardFeedGet' | 'hostedCardFeedRefresh'>

function getHostedCardFeedApi(): HostedCardFeedApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  return api && typeof api.hostedCardFeedGet === 'function' && typeof api.hostedCardFeedRefresh === 'function'
    ? api
    : null
}

export function createHostedCardFeedSlice(
  set: HostedCardFeedSliceSet,
  deps: { getApi?: () => HostedCardFeedApi | null } = {},
): HostedCardFeedSlice {
  const getApi = deps.getApi ?? getHostedCardFeedApi

  const apply = (result: HostedCardFeedReadResult): void => {
    set((state) => {
      if (result.ok) {
        state.cards = result.feed.cards
        state.cardFeedStatus = 'ready'
        state.cardFeedError = null
        return
      }
      // A failed read keeps whatever cards were showing: the feed going away
      // must never empty the page.
      state.cardFeedStatus = 'error'
      state.cardFeedError = result.message
    })
  }

  const begin = (): void => {
    set((state) => {
      // Only a page with nothing to draw is loading. A re-read behind cards
      // that are already on screen is not a spinner.
      if (state.cards.length === 0) state.cardFeedStatus = 'loading'
    })
  }

  return {
    cards: [],
    cardFeedStatus: 'idle',
    cardFeedError: null,
    applyHostedCardFeedResult: apply,
    loadCards: async () => {
      const api = getApi()
      if (!api) return
      begin()
      try {
        apply(await api.hostedCardFeedGet())
      } catch (error) {
        apply(failure(error))
      }
    },
    refreshCards: async (options = {}) => {
      const api = getApi()
      if (!api) return null
      begin()
      try {
        const result = await api.hostedCardFeedRefresh(options.force ? { forceRefresh: true } : undefined)
        apply(result)
        return result
      } catch (error) {
        const result = failure(error)
        apply(result)
        return result
      }
    },
  }
}

function failure(error: unknown): HostedCardFeedReadResult {
  return {
    ok: false,
    state: 'fetch-error',
    feedUrl: '',
    message: error instanceof Error ? error.message : String(error),
  }
}

// Wire the main-process push into the store. Returns the unsubscribe.
export function subscribeHostedCardFeedChanges(
  apply: (result: HostedCardFeedReadResult) => void,
  api: Pick<Window['api'], 'onHostedCardFeedChanged'> | null = typeof window === 'undefined' ? null : window.api,
): () => void {
  if (!api || typeof api.onHostedCardFeedChanged !== 'function') return () => {}
  return api.onHostedCardFeedChanged(apply)
}
