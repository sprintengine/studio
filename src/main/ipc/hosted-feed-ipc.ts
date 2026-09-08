import type { IpcMain } from 'electron'

import type {
  HostedModelFeedReadInput,
  HostedModelFeedReadResult,
  HostedSourcesFeedReadResult,
} from '../../shared/electron-api'
import { configuredModelFeedUrl } from '../hosted-feed/model-feed-client'
import { readHostedModelFeed } from '../hosted-feed/hosted-feed-service'
import { configuredSourcesFeedUrl } from '../hosted-feed/sources-feed-client'
import { readHostedSourcesFeed } from '../hosted-feed/sources-feed-service'
import { isRecord } from '../../shared/records'

export type HostedModelFeedIpcHandlers = {
  read(input?: HostedModelFeedReadInput): Promise<HostedModelFeedReadResult>
  readSources(): Promise<HostedSourcesFeedReadResult>
}

// `hosted-model-feed:get` serves what is on disk (cache, else seed) and never
// touches the network — store boot calls it so pickers render at once.
// `hosted-model-feed:refresh` may fetch; the client's TTL and retry gap decide
// whether it actually does unless `forceRefresh` is set (Settings "Check now").
// A fetch that changes the feed is pushed to every window as
// `hosted-model-feed:changed` by the service, so callers do not re-broadcast.
export function registerHostedModelFeedIpc(
  ipcMain: IpcMain,
  overrides: Partial<HostedModelFeedIpcHandlers> = {},
): void {
  const read = overrides.read ?? ((input?: HostedModelFeedReadInput) => readHostedModelFeed(input))
  const readSources = overrides.readSources ?? (() => readHostedSourcesFeed({ cachedOnly: true }))

  // `hosted-sources-feed:get` serves what is on disk (cache, else seed) and
  // never touches the network: the Extensions door draws its recommended
  // sources on open, and must not wait out a fetch to do it. The poller's feed
  // leg is what keeps that disk copy fresh (MC-2519).
  ipcMain.handle('hosted-sources-feed:get', async (): Promise<HostedSourcesFeedReadResult> => {
    try {
      return await readSources()
    } catch (error) {
      return {
        ok: false,
        state: 'fetch-error',
        feedUrl: configuredSourcesFeedUrl(),
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })

  ipcMain.handle('hosted-model-feed:get', async (): Promise<HostedModelFeedReadResult> => {
    try {
      return await read({ cachedOnly: true })
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('hosted-model-feed:refresh', async (_event, input?: unknown): Promise<HostedModelFeedReadResult> => {
    const forceRefresh = isRecord(input) && input.forceRefresh === true
    try {
      return await read(forceRefresh ? { forceRefresh: true } : {})
    } catch (error) {
      return failure(error)
    }
  })
}

function failure(error: unknown): HostedModelFeedReadResult {
  return {
    ok: false,
    state: 'fetch-error',
    feedUrl: configuredModelFeedUrl(),
    message: error instanceof Error ? error.message : String(error),
  }
}

