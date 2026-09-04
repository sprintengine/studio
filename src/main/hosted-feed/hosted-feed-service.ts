// The one hosted-model-feed client per app instance, and the read that tells
// every window when the feed changed. IPC (hosted-feed-ipc) and the poller both
// go through `readHostedModelFeed`, so a scheduled tick and a manual "Check now"
// share the client's in-flight guard, cache, and retry gap.
import { app, BrowserWindow } from 'electron'

import type { HostedModelFeedReadInput, HostedModelFeedReadResult } from '../../shared/electron-api'
import {
  HostedModelFeedClient,
  configuredModelFeedUrl,
  defaultModelFeedCachePath,
  modelFeedSeedCandidates,
} from './model-feed-client'
import { existsSync } from 'node:fs'

export const HOSTED_MODEL_FEED_CHANGED_CHANNEL = 'hosted-model-feed:changed'

let client: HostedModelFeedClient | null = null

export function getHostedModelFeedClient(): HostedModelFeedClient {
  if (client) return client
  const candidates = modelFeedSeedCandidates({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: typeof app.getAppPath === 'function' ? app.getAppPath() : null,
    cwd: process.cwd(),
  })
  client = new HostedModelFeedClient({
    feedUrl: configuredModelFeedUrl(),
    cachePath: defaultModelFeedCachePath(app.getPath('userData')),
    packagedSeedPath: candidates.find((candidate) => existsSync(candidate)) ?? null,
  })
  return client
}

// Test seam: replace the client (and the broadcast) without Electron.
export function setHostedModelFeedClientForTests(next: HostedModelFeedClient | null): void {
  client = next
}

export type HostedModelFeedBroadcast = (result: HostedModelFeedReadResult) => void

const defaultBroadcast: HostedModelFeedBroadcast = (result) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(HOSTED_MODEL_FEED_CHANGED_CHANNEL, result)
  }
}

export async function readHostedModelFeed(
  input: HostedModelFeedReadInput = {},
  broadcast: HostedModelFeedBroadcast = defaultBroadcast,
): Promise<HostedModelFeedReadResult> {
  const result = await getHostedModelFeedClient().read(input)
  if (result.ok && result.changed) broadcast(result)
  return result
}
