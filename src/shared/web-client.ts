// What a web tab and the server's web front door agree on beyond the
// protocol: the tunnelled channels only a web tab uses, and their shapes.

import type { ServerIpcChannel } from './ipc-channel-owners'

/** The server-side folder browser that stands in for the native folder picker (phase 9 spec, 6.5). */
export const WEB_BROWSE_FOLDERS_CHANNEL = 'web:browse-folders'

/** Previews of an agent's dev server, each on an origin of its own (phase 9 spec, 3.6; R77). */
export const WEB_PREVIEWS_LIST_CHANNEL = 'web:previews:list'
export const WEB_PREVIEWS_OPEN_CHANNEL = 'web:previews:open'
export const WEB_PREVIEWS_CLOSE_CHANNEL = 'web:previews:close'
/** Pushed to a session's tabs: its open previews, whole, on every change. */
export const WEB_PREVIEWS_CHANGED_CHANNEL = 'web:previews:changed'

/** The channels the web front door adds to a tab's tunnel, beside the server's own (SERVER_IPC_CHANNELS). */
export const WEB_TUNNEL_CHANNELS: Readonly<Record<string, ServerIpcChannel>> = {
  [WEB_BROWSE_FOLDERS_CHANNEL]: { retry: 'once' },
  [WEB_PREVIEWS_LIST_CHANNEL]: { retry: 'once' },
  [WEB_PREVIEWS_OPEN_CHANNEL]: {},
  [WEB_PREVIEWS_CLOSE_CHANNEL]: {},
}

/** A port an agent of the server listens on, offered for a preview. */
export type PreviewPort = { port: number; pid: number; command: string }

/** An open preview, as the tab that opened it sees it. */
export type PreviewSummary = { previewId: string; port: number; origin: string; openedAt: number; lastUsedAt: number }

export type PreviewOpenAnswer =
  { ok: true; previewId: string; origin: string; enterUrl: string } | { ok: false; message: string }

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
