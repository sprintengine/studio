import type { HostedModelFeedReadResult } from '../../../../shared/electron-api'
import { hostedModelsByCli, type HostedCliModelCatalogs } from '../../../../shared/hosted-model-feed'

// The hosted model feed as the renderer sees it. Not persisted: the main
// process owns the cache on disk and serves it at boot, so a schema bump is not
// needed and a stale renderer copy cannot outlive the file. `hostedModelFeed`
// is the last read (source, time, message) for the Settings line;
// `hostedModelCatalogs` is the same feed split per plugin id, the shape
// cliRuntimeOptions.mergeModelCatalog takes.
export interface HostedModelFeedSliceState {
  hostedModelFeed: HostedModelFeedReadResult | null
  hostedModelCatalogs: HostedCliModelCatalogs
}

export interface HostedModelFeedSliceActions {
  // Boot: what is on disk, no network. Never throws; a missing api is a no-op.
  loadHostedModelFeed: () => Promise<void>
  // "Check now" (force) or a scheduled tick from the renderer side. The main
  // process pushes `hosted-model-feed:changed` when the feed differs, but the
  // result is applied here too so the caller's own copy is current at once.
  refreshHostedModelFeed: (options?: { force?: boolean }) => Promise<HostedModelFeedReadResult | null>
  // The push handler. Also what tests drive directly.
  applyHostedModelFeedResult: (result: HostedModelFeedReadResult) => void
}

export type HostedModelFeedSlice = HostedModelFeedSliceState & HostedModelFeedSliceActions

type HostedModelFeedSliceSet = (mutator: (state: HostedModelFeedSliceState) => void) => void

type HostedModelFeedApi = Pick<Window['api'], 'hostedModelFeedGet' | 'hostedModelFeedRefresh'>

function getHostedModelFeedApi(): HostedModelFeedApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  return api && typeof api.hostedModelFeedGet === 'function' && typeof api.hostedModelFeedRefresh === 'function'
    ? api
    : null
}

export function createHostedModelFeedSlice(
  set: HostedModelFeedSliceSet,
  deps: { getApi?: () => HostedModelFeedApi | null } = {},
): HostedModelFeedSlice {
  const getApi = deps.getApi ?? getHostedModelFeedApi

  const apply = (result: HostedModelFeedReadResult): void => {
    set((state) => {
      state.hostedModelFeed = result
      // A failed read with nothing to serve keeps whatever rows were showing:
      // the feed going away must never empty a picker.
      if (result.ok) state.hostedModelCatalogs = hostedModelsByCli(result.feed)
    })
  }

  return {
    hostedModelFeed: null,
    hostedModelCatalogs: {},
    applyHostedModelFeedResult: apply,
    loadHostedModelFeed: async () => {
      const api = getApi()
      if (!api) return
      try {
        apply(await api.hostedModelFeedGet())
      } catch {
        // Boot must not fail on the feed; the seed-less, cache-less case is a
        // machine that has never fetched, and the manifests still render.
      }
    },
    refreshHostedModelFeed: async (options = {}) => {
      const api = getApi()
      if (!api) return null
      try {
        const result = await api.hostedModelFeedRefresh(options.force ? { forceRefresh: true } : undefined)
        apply(result)
        return result
      } catch (error) {
        const failure: HostedModelFeedReadResult = {
          ok: false,
          state: 'fetch-error',
          feedUrl: '',
          message: error instanceof Error ? error.message : String(error),
        }
        apply(failure)
        return failure
      }
    },
  }
}

// Wire the main-process push into the store. Returns the unsubscribe.
export function subscribeHostedModelFeedChanges(
  apply: (result: HostedModelFeedReadResult) => void,
  api: Pick<Window['api'], 'onHostedModelFeedChanged'> | null = typeof window === 'undefined' ? null : window.api,
): () => void {
  if (!api || typeof api.onHostedModelFeedChanged !== 'function') return () => {}
  return api.onHostedModelFeedChanged(apply)
}
