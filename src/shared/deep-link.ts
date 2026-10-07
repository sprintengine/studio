import { CURRENT_DEEP_LINK_SCHEME, DEEP_LINK_SCHEMES } from './deep-link-scheme'

// What a `sprintengine://` link may ask of the app, and nothing more.
//
// A link is untrusted input: any web page or app on the machine can open one,
// and the OS hands it over without asking the person. So the grammar is a short
// allowlist, read by hand rather than by `new URL` (which resolves `..` and
// folds what it cannot read into something it can), and everything it does not
// name is a link that is ignored:
//
//   sprintengine://auth/callback?…           the sign-in callback, which
//                                            auth-service reads itself
//   sprintengine://chat/<chatId>             open that chat
//   sprintengine://chat/<chatId>?agent=<id>  …on that agent's tab
//
// A chat link only navigates. It never starts an agent, never puts words in a
// composer and never sends anything; there is deliberately no link that does,
// because a page the person happened to visit would be the one deciding. The
// ids it carries are matched against the chats on record and go nowhere else —
// not into a path, not into a command.

export type DeepLink =
  | { kind: 'auth' }
  | {
      kind: 'chat'
      /** The chat's workspace id, the one its sidebar row has. */
      chatId: string
      /** One of its agents, whose tab comes forward; null for the chat as it was left. */
      agentId: string | null
    }

export type ChatLink = Extract<DeepLink, { kind: 'chat' }>

/** Main to a workspace window: open this chat. */
export const CHAT_LINK_OPEN_CHANNEL = 'chat-link:open'
/** A workspace window to main: its registry is loaded and it is listening for chat links. */
export const CHAT_LINK_READY_CHANNEL = 'chat-link:ready'
/** A workspace window to main: it stopped listening. */
export const CHAT_LINK_UNREADY_CHANNEL = 'chat-link:unready'

// Far longer than any link the app writes, and short enough that nothing is
// spent on a megabyte of query string.
const MAX_LINK_LENGTH = 2048

// Every id the app mints fits (nanoid, the registry's hex, `agent-<cli>-<suffix>`,
// a module's own keys), and nothing that could mean something else to a shell
// or a file system does: no dot, slash, percent, quote or space.
const LINK_ID = /^[A-Za-z0-9_-]{1,128}$/

// scheme :// authority path ? query # fragment, each part taken as written.
const LINK_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/

// Anything at or below a space, and DEL: a link the OS handed over intact has
// none, and one that does is not a link the app wrote.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/

/** What the link asks for; null for anything that is not one of the app's links. */
export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK_LENGTH) return null
  if (CONTROL_OR_SPACE.test(raw)) return null
  const shape = LINK_SHAPE.exec(raw)
  if (!shape) return null
  const [, scheme = '', authority = '', path = '', query = ''] = shape
  // Scheme and host are case-insensitive, and nothing promises which case the
  // OS hands back. A user, password or port makes the authority something
  // other than the bare word, so it is refused here too.
  if (!(DEEP_LINK_SCHEMES as readonly string[]).includes(scheme.toLowerCase())) return null
  const host = authority.toLowerCase()

  if (host === 'auth') return path === '/callback' ? { kind: 'auth' } : null
  if (host !== 'chat') return null

  // One segment, and a trailing slash, which some browsers on Windows add to a
  // link they hand to its app.
  const segment = /^\/([^/]+)\/?$/.exec(path)?.[1]
  if (!segment || !LINK_ID.test(segment)) return null

  // The one parameter read. Any other is ignored rather than refused, so a link
  // a newer build writes still opens its chat here. An agent named twice, or
  // not in the id alphabet, is dropped and the chat still opens.
  const agents = new URLSearchParams(query).getAll('agent')
  const agent = agents.length === 1 ? agents[0] : undefined
  return { kind: 'chat', chatId: segment, agentId: agent && LINK_ID.test(agent) ? agent : null }
}

/** The first chat link among a launch's arguments, the way Windows and Linux hand one over. */
export function chatLinkFromArgv(argv: readonly string[]): ChatLink | null {
  for (const arg of argv) {
    const link = parseDeepLink(arg)
    if (link?.kind === 'chat') return link
  }
  return null
}

/**
 * The link that opens a chat, or null when its id is one a link cannot carry
 * (an id from before the alphabet above, say), so a menu never offers to copy a
 * link that would not open.
 */
export function chatLinkFor(chatId: string, agentId?: string | null): string | null {
  if (!LINK_ID.test(chatId)) return null
  if (agentId != null && !LINK_ID.test(agentId)) return null
  const base = `${CURRENT_DEEP_LINK_SCHEME}://chat/${chatId}`
  return agentId ? `${base}?agent=${agentId}` : base
}
