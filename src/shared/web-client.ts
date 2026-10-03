// What a web tab and the server's web front door agree on beyond the
// protocol: the tunnelled channels only a web tab uses, and their shapes.

import type { ServerIpcChannel } from './ipc-channel-owners'

/** The server-side folder browser that stands in for the native folder picker (phase 9 spec, 6.5). */
export const WEB_BROWSE_FOLDERS_CHANNEL = 'web:browse-folders'

/** The channels the web front door adds to a tab's tunnel, beside the server's own (SERVER_IPC_CHANNELS). */
export const WEB_TUNNEL_CHANNELS: Readonly<Record<string, ServerIpcChannel>> = {
  [WEB_BROWSE_FOLDERS_CHANNEL]: { retry: 'once' },
}

export type FolderBrowserEntry = { name: string; path: string; project: boolean; hint: 'not-a-project' | null }

export type FolderBrowserListing =
  | {
      ok: true
      path: string
      parent: string | null
      home: string
      entries: FolderBrowserEntry[]
      truncated: boolean
    }
  | { ok: false; message: string }
