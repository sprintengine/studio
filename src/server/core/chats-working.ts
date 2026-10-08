import type { ConversationBackend } from './conversation-backend'

/**
 * Whether a chat is working: starting, mid-turn, waiting on a person, or
 * running background agents. What keeps a server from stopping for being
 * idle, whether it reads its own chats or a WSL server's over the wire.
 */
export function chatsAreWorking(conversations: Pick<ConversationBackend, 'listSessions'>): boolean {
  const listed = conversations.listSessions()
  if (!listed.ok) return false
  return listed.sessions.some(
    (session) =>
      session.status === 'starting' ||
      session.status === 'active' ||
      session.status === 'awaiting_approval' ||
      session.turnStartedAt !== undefined ||
      (session.backgroundAgents ?? 0) > 0,
  )
}
