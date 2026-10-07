import { join } from 'node:path'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { ConversationGatewayHost } from '../../main/automation/tailnet/tailnet-conversation-host'
import {
  createScheduledMessages,
  SCHEDULED_MESSAGES_FILE,
  scheduledMessagesFileStorage,
  type ScheduledMessages,
  type ScheduledMessagesStorage,
} from '../../main/scheduled-messages/scheduled-messages'

// The Studio core's scheduled messages (main/scheduled-messages), wired to
// what the core holds: its chats and their events, the registry's records, and
// a conversation host whose sends are the person's own. Kept apart from the
// core's composition so the wiring is tested as the core builds it.

/** The client a scheduled message is sent as, for the runtime's command receipts. */
export const STUDIO_SCHEDULED_MESSAGE_CLIENT_ID = 'studio-scheduled-message'

export type StudioScheduledMessagesDeps = {
  dataDir: string
  conversations: {
    listSessions(): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message?: string }
    onEvent(listener: (event: ConversationEvent) => void): () => void
  }
  /** A workspace's record: the agents (chats) it holds. */
  workspaceRecord: (workspaceId: string) => { agents: Record<string, unknown> } | null
  /** A conversation host whose sends are recorded as the person's. */
  createHost: () => Pick<ConversationGatewayHost, 'resolveKey' | 'command'>
  storage?: ScheduledMessagesStorage
  now?: () => number
  log?: (message: string) => void
}

export function createStudioScheduledMessages(deps: StudioScheduledMessagesDeps): ScheduledMessages {
  let host: ReturnType<StudioScheduledMessagesDeps['createHost']> | null = null
  return createScheduledMessages({
    storage: deps.storage ?? scheduledMessagesFileStorage(join(deps.dataDir, SCHEDULED_MESSAGES_FILE)),
    listSessions: () => {
      const listed = deps.conversations.listSessions()
      return listed.ok ? listed.sessions : []
    },
    onConversationEvent: (listener) => deps.conversations.onEvent(listener),
    chatExists: ({ workspaceId, agentId }) => {
      const record = deps.workspaceRecord(workspaceId)
      return Boolean(record && Object.hasOwn(record.agents, agentId))
    },
    // Through the same send a paired device's goes, which resumes a chat with
    // no live session from its record. No origin: the words are the person's,
    // and the chat counts them as their last message.
    send: async (chat, text, commandId) => {
      host ??= deps.createHost()
      const key = host.resolveKey(chat.workspaceId, chat.agentId)
      if (!key) return { ok: false, message: 'The chat has no folder on this machine' }
      return host.command(key, STUDIO_SCHEDULED_MESSAGE_CLIENT_ID, commandId, { kind: 'send', message: text })
    },
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
}
