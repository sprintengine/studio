import type { IpcMain } from 'electron'

import type { HostedCardFeedReadInput, HostedCardFeedReadResult } from '../../shared/electron-api'
import { configuredCardFeedUrl } from '../hosted-feed/card-feed-client'
import { readHostedCardFeed } from '../hosted-feed/card-feed-service'

export type HostedCardFeedIpcHandlers = {
  read(input?: HostedCardFeedReadInput): Promise<HostedCardFeedReadResult>
}

// `hosted-card-feed:get` serves what is on disk (cache, else seed) and never
// touches the network — it is the first-paint path, and the Extensions home is
// a page of pictures that must draw before anyone has finished pressing the
// door. It passes `cachedOnly`, which the client answers off its own path
// rather than joining whatever fetch happens to be in flight, so nothing about
// GitHub's mood can put a spinner on the home page.
// `hosted-card-feed:refresh` may fetch; the client's TTL and retry gap decide
// whether it actually does unless `forceRefresh` is set. A read that changed
// the feed is pushed to every window as `hosted-card-feed:changed` by the
// service, so callers do not re-broadcast.
export function registerHostedCardFeedIpc(
  ipcMain: IpcMain,
  overrides: Partial<HostedCardFeedIpcHandlers> = {},
): void {
  const read = overrides.read ?? ((input?: HostedCardFeedReadInput) => readHostedCardFeed(input))

  ipcMain.handle('hosted-card-feed:get', async (): Promise<HostedCardFeedReadResult> => {
    try {
      return await read({ cachedOnly: true })
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('hosted-card-feed:refresh', async (_event, input?: unknown): Promise<HostedCardFeedReadResult> => {
    const forceRefresh = isObject(input) && input.forceRefresh === true
    try {
      return await read(forceRefresh ? { forceRefresh: true } : {})
    } catch (error) {
      return failure(error)
    }
  })
}

function failure(error: unknown): HostedCardFeedReadResult {
  return {
    ok: false,
    state: 'fetch-error',
    feedUrl: configuredCardFeedUrl(),
    message: error instanceof Error ? error.message : String(error),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
