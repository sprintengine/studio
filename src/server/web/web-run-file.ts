import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Where a running server's web listener is, and the key that mints a pairing
// code there: `run/web.json`, 0600 in the owner-only `run/`. Read by
// `studio-server pair`, which is another process on the same machine; being
// able to read the file is being the server's owner here. Its own module so
// the CLI reads it without loading the web front door.

export const WEB_RUN_FILENAME = 'web.json'

export type WebRunFile = { pid: number; port: number; url: string; origins: string[]; mintKey: string }

export function readWebRunFile(dataDir: string): WebRunFile | null {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, 'run', WEB_RUN_FILENAME), 'utf8')) as Partial<WebRunFile>
    if (typeof value.port !== 'number' || typeof value.url !== 'string' || typeof value.mintKey !== 'string')
      return null
    return {
      pid: typeof value.pid === 'number' ? value.pid : 0,
      port: value.port,
      url: value.url,
      origins: Array.isArray(value.origins) ? value.origins.filter((entry) => typeof entry === 'string') : [],
      mintKey: value.mintKey,
    }
  } catch {
    return null
  }
}
