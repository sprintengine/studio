import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import {
  CONVERSATION_COMMANDS_CHANGED_CHANNEL,
  CONVERSATION_COMMANDS_LIST_CHANNEL,
  type ConversationCommandsRequest,
} from '../../shared/ipc/conversation-commands'

// `onConversationCommandsChanged` returns the unsubscribe, so the composer
// can let go of the push when no chat is reading a list any more.
export const conversationCommandsApi = {
  conversationCommands: (input: ConversationCommandsRequest): Promise<ConversationCommandCatalog> =>
    ipcRenderer.invoke(CONVERSATION_COMMANDS_LIST_CHANNEL, input),
  onConversationCommandsChanged: (listener: (catalog: ConversationCommandCatalog) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, catalog: ConversationCommandCatalog): void => listener(catalog)
    ipcRenderer.on(CONVERSATION_COMMANDS_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CONVERSATION_COMMANDS_CHANGED_CHANNEL, handler)
  },
} satisfies Pick<ElectronApi, 'conversationCommands' | 'onConversationCommandsChanged'>
