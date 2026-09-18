// The one hosted-sources-feed client per app instance. The IPC handler
// (hosted-feed-ipc) and the poller both go through `readHostedSourcesFeed`, so
// a scheduled tick and a window opening share the client's in-flight guard,
// cache, and retry gap.
import { app } from 'electron'

import type { HostedSourcesFeedReadInput, HostedSourcesFeedReadResult } from '../../shared/electron-api'
import {
  HostedSourcesFeedClient,
  configuredSourcesFeedUrl,
  defaultSourcesFeedCachePath,
  sourcesFeedSeedCandidates,
} from './sources-feed-client'
import { existsSync } from 'node:fs'

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

export function readHostedSourcesFeed(input: HostedSourcesFeedReadInput = {}): Promise<HostedSourcesFeedReadResult> {
  return getHostedSourcesFeedClient().read(input)
}
