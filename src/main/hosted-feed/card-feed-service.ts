// The one hosted-card-feed client per app instance, and the read that tells
// every window when the feed changed. The IPC pair (card-feed-ipc) goes through
// `readHostedCardFeed`, so the first paint's disk read and a later refresh share
// the client's in-flight guard, cache, and retry gap — a window that opens while
// another window is fetching does not start a second fetch.
//
// The broadcast is guarded on `result.changed` and nothing else. A read that
// served the same copy back is not news, and waking every window for it would
// make the Extensions home redraw on a timer for no reason; the client already
// says whether it wrote something different, so this file only has to believe it.
import { app, BrowserWindow } from 'electron'

import type { HostedCardFeedReadInput, HostedCardFeedReadResult } from '../../shared/electron-api'
import {
  HostedCardFeedClient,
  cardFeedSeedCandidates,
  configuredCardFeedUrl,
  defaultCardFeedCachePath,
} from './card-feed-client'
import { existsSync } from 'node:fs'

export const HOSTED_CARD_FEED_CHANGED_CHANNEL = 'hosted-card-feed:changed'

let client: HostedCardFeedClient | null = null

export function getHostedCardFeedClient(): HostedCardFeedClient {
  if (client) return client
  const candidates = cardFeedSeedCandidates({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: typeof app.getAppPath === 'function' ? app.getAppPath() : null,
    cwd: process.cwd(),
  })
  client = new HostedCardFeedClient({
    feedUrl: configuredCardFeedUrl(),
    cachePath: defaultCardFeedCachePath(app.getPath('userData')),
    packagedSeedPath: candidates.find((candidate) => existsSync(candidate)) ?? null,
  })
  return client
}

// Test seam: replace the client (and the broadcast) without Electron.
export function setHostedCardFeedClientForTests(next: HostedCardFeedClient | null): void {
  client = next
}

export type HostedCardFeedBroadcast = (result: HostedCardFeedReadResult) => void

const defaultBroadcast: HostedCardFeedBroadcast = (result) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(HOSTED_CARD_FEED_CHANGED_CHANNEL, result)
  }
}

export async function readHostedCardFeed(
  input: HostedCardFeedReadInput = {},
  broadcast: HostedCardFeedBroadcast = defaultBroadcast,
): Promise<HostedCardFeedReadResult> {
  const result = await getHostedCardFeedClient().read(input)
  if (result.ok && result.changed) broadcast(result)
  return result
}
