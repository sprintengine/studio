import { ipcRenderer } from 'electron'

import type { ConversationPeek } from '../../shared/conversation-peek'
import type { ElectronApi } from '../../shared/electron-api'

/**
 * The conversation peek's two calls. Read on hover; open when a chip on the
 * card is clicked.
 *
 * Both take ids and nothing else: the renderer never names a transcript, a path
 * or a file, so nothing it sends can widen what main will read or open — main
 * resolves an attachment id against the peek it just handed out.
 */
type ConversationPeekIpcRenderer = {
  invoke(channel: 'conversation-peek:read', sessionId: string): Promise<ConversationPeek>
  invoke(
    channel: 'conversation-peek:open-attachment',
    input: { sessionId: string; attachmentId: string },
  ): Promise<void>
}

export function createConversationPeekApi(renderer: ConversationPeekIpcRenderer) {
  return {
    readConversationPeek: (sessionId: string): Promise<ConversationPeek> =>
      renderer.invoke('conversation-peek:read', sessionId),
    openConversationPeekAttachment: (sessionId: string, attachmentId: string): Promise<void> =>
      renderer.invoke('conversation-peek:open-attachment', { sessionId, attachmentId }),
  } satisfies Pick<ElectronApi, 'readConversationPeek' | 'openConversationPeekAttachment'>
}

export const conversationPeekApi = createConversationPeekApi(ipcRenderer)
