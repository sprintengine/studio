import type { IpcMain } from 'electron'

import type { HostedModelFeedReadInput, HostedModelFeedReadResult } from '../../shared/electron-api'
import { configuredModelFeedUrl } from '../hosted-feed/model-feed-client'
import { readHostedModelFeed } from '../hosted-feed/hosted-feed-service'

export type HostedModelFeedIpcHandlers = {
  read(input?: HostedModelFeedReadInput): Promise<HostedModelFeedReadResult>
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

  ipcMain.handle('hosted-model-feed:get', async (): Promise<HostedModelFeedReadResult> => {
    try {
      return await read({ cachedOnly: true })
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('hosted-model-feed:refresh', async (_event, input?: unknown): Promise<HostedModelFeedReadResult> => {
    const forceRefresh = isObject(input) && input.forceRefresh === true
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
