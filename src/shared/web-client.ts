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

/** Embeds of one conversation, read-only, for another page to frame (phase 9 spec, 5.4; R58, R59). */
export const WEB_EMBEDS_CREATE_CHANNEL = 'web:embeds:create'
export const WEB_EMBEDS_LIST_CHANNEL = 'web:embeds:list'
export const WEB_EMBEDS_REVOKE_CHANNEL = 'web:embeds:revoke'

/** The channels the web front door adds to a tab's tunnel, beside the server's own (SERVER_IPC_CHANNELS). */
export const WEB_TUNNEL_CHANNELS: Readonly<Record<string, ServerIpcChannel>> = {
  [WEB_BROWSE_FOLDERS_CHANNEL]: { retry: 'once' },
  [WEB_PREVIEWS_LIST_CHANNEL]: { retry: 'once' },
  [WEB_PREVIEWS_OPEN_CHANNEL]: {},
  [WEB_PREVIEWS_CLOSE_CHANNEL]: {},
  [WEB_EMBEDS_CREATE_CHANNEL]: {},
  [WEB_EMBEDS_LIST_CHANNEL]: { retry: 'once' },
  [WEB_EMBEDS_REVOKE_CHANNEL]: {},
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

// What an owner's web tab may reach over its tunnel (phase 9 spec, 14.8): the
// domains the web client draws, and not the ones that act beyond this server
// or hand out credentials. Pairing local apps and other machines, the tailnet
// lane's administration, and setting or clearing provider keys and the GitHub
// token stay with the desktop app; their reads that the web client shows
// (whether a key is set) do not. The renderer routes only these channels to
// the tunnel, and the server refuses any other there, so the list is held on
// both sides.
const WEB_TUNNEL_DOMAINS = new Set([
  'automation',
  'backlog',
  'cli-models',
  'conversation-commands',
  'hosts',
  'launch-settings',
  'workspace-backup',
  'workspace-registry',
  'workspace-sync',
])
const WEB_TUNNEL_EXCLUDED = new Set([
  // A provider's key, set or cleared, and the CLI's own sign-in, which opens a terminal.
  'conversation:secrets:set',
  'conversation:secrets:clear',
  'conversation:providers:sign-in',
  // A chat handed to a terminal: there are none on the web (ruling a).
  'conversation:sessions:terminal-handoff',
])
const WEB_TUNNEL_SINGLE = new Set([
  'credential:secrets:status',
  'github:token-status',
  'github:list-repos',
  'scheduled-agents:list',
  'scheduled-agents:mark-seen',
])

/** Whether an owner's web tab may use a server-owned tunnel channel. */
export function webTunnelAllows(channel: string): boolean {
  if (Object.hasOwn(WEB_TUNNEL_CHANNELS, channel)) return true
  if (WEB_TUNNEL_SINGLE.has(channel)) return true
  const domain = channel.split(':')[0]
  if (domain === 'conversation') return !WEB_TUNNEL_EXCLUDED.has(channel)
  return WEB_TUNNEL_DOMAINS.has(domain)
}

/** The answer a web tab gets for a tunnel channel it may not use. */
export const WEB_TUNNEL_REFUSED = 'DesktopOnly'
