// The one hosted-sources-feed client per app instance, and the read that tells
// every window when the recommended list changed. The IPC handler
// (hosted-feed-ipc) and the poller both go through `readHostedSourcesFeed`, so
// a scheduled tick and a window opening share the client's in-flight guard,
// cache, and retry gap.
//
// The broadcast is guarded on `result.changed` and nothing else: a read that
// served the same list back is not news, and waking every window for it would
// redraw the Extensions door on a timer for no reason.
import { app, BrowserWindow } from 'electron'

import type { HostedSourcesFeedReadInput, HostedSourcesFeedReadResult } from '../../shared/electron-api'
import {
  HostedSourcesFeedClient,
  configuredSourcesFeedUrl,
  defaultSourcesFeedCachePath,
  sourcesFeedSeedCandidates,
} from './sources-feed-client'
import { existsSync } from 'node:fs'

export const HOSTED_SOURCES_FEED_CHANGED_CHANNEL = 'hosted-sources-feed:changed'

let client: HostedSourcesFeedClient | null = null

function getHostedSourcesFeedClient(): HostedSourcesFeedClient {
  if (client) return client
  const candidates = sourcesFeedSeedCandidates({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: typeof app.getAppPath === 'function' ? app.getAppPath() : null,
    cwd: process.cwd(),
  })
  client = new HostedSourcesFeedClient({
    feedUrl: configuredSourcesFeedUrl(),
    cachePath: defaultSourcesFeedCachePath(app.getPath('userData')),
    packagedSeedPath: candidates.find((candidate) => existsSync(candidate)) ?? null,
  })
  return client
}

/** Test seam: hand the service a client with a fake fetcher and temp paths. */
export function setHostedSourcesFeedClientForTests(next: HostedSourcesFeedClient | null): void {
  client = next
}

export type HostedSourcesFeedBroadcast = (result: HostedSourcesFeedReadResult) => void

const defaultBroadcast: HostedSourcesFeedBroadcast = (result) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(HOSTED_SOURCES_FEED_CHANGED_CHANNEL, result)
  }
}

export async function readHostedSourcesFeed(
  input: HostedSourcesFeedReadInput = {},
  broadcast: HostedSourcesFeedBroadcast = defaultBroadcast,
): Promise<HostedSourcesFeedReadResult> {
  const result = await getHostedSourcesFeedClient().read(input)
  if (result.ok && result.changed) broadcast(result)
  return result
}
