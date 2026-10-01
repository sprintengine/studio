import type { IpcMain } from 'electron'

import type { HostedSourcesFeedReadResult } from '../../shared/electron-api'
import { configuredSourcesFeedUrl } from '../hosted-feed/sources-feed-client'
import { readHostedSourcesFeed } from '../hosted-feed/sources-feed-service'

export type HostedSourcesFeedIpcHandlers = {
  readSources(): Promise<HostedSourcesFeedReadResult>
}

// `hosted-sources-feed:get` serves what is on disk (cache, else seed) and
// never touches the network: the Extensions door draws its recommended
// sources on open, and must not wait out a fetch to do it. The poller's feed
// leg is what keeps that disk copy fresh.
export function registerHostedSourcesFeedIpc(
  ipcMain: IpcMain,
  overrides: Partial<HostedSourcesFeedIpcHandlers> = {},
): void {
  const readSources = overrides.readSources ?? (() => readHostedSourcesFeed({ cachedOnly: true }))

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
}
