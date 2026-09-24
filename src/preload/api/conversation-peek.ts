import { ipcRenderer } from 'electron'

import type { ConversationPeek } from '../../shared/conversation-peek'
import type { ElectronApi } from '../../shared/electron-api'

/**
 * The conversation peek's one call, made on hover. It takes a session id and
 * nothing else, so nothing the renderer sends can widen what main will read.
 */
type ConversationPeekIpcRenderer = {
  invoke(channel: 'conversation-peek:read', sessionId: string): Promise<ConversationPeek>
}

export function createConversationPeekApi(renderer: ConversationPeekIpcRenderer) {
  return {
    readConversationPeek: (sessionId: string): Promise<ConversationPeek> =>
      renderer.invoke('conversation-peek:read', sessionId),
  } satisfies Pick<ElectronApi, 'readConversationPeek'>
}

export const conversationPeekApi = createConversationPeekApi(ipcRenderer)
