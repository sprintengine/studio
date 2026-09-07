import type { IpcMain } from 'electron'

import type { ConversationPeek } from '../../shared/conversation-peek'
import { emptyConversationPeek } from '../../shared/conversation-peek'

/**
 * The two channels behind the conversation peek. Read-only plus one open action,
 * both keyed by the terminal session the card is anchored to.
 *
 * Both payloads are validated here rather than trusted: a renderer is the least
 * trusted caller main has, and the session id it sends is used to look up a
 * session and, through it, a transcript path. A malformed read answers with the
 * empty peek — the state the card already renders for a chat with nothing to
 * show — rather than throwing, so a hover can never surface an error dialog.
 */
export type ConversationPeekIpcDependencies = {
  readConversationPeek(sessionId: string): Promise<ConversationPeek>
  openConversationPeekAttachment(sessionId: string, attachmentId: string): Promise<void>
}

/** Cap on an id off the wire. Session and attachment ids are uuid-shaped; this is an abuse guard. */
const MAX_ID_LENGTH = 512

export function registerConversationPeekIpc(
  ipcMain: IpcMain,
  deps: ConversationPeekIpcDependencies,
): void {
  ipcMain.handle('conversation-peek:read', (_event, sessionId: unknown): Promise<ConversationPeek> => {
    if (!isId(sessionId)) return Promise.resolve(emptyConversationPeek(''))
    return deps.readConversationPeek(sessionId)
  })

  ipcMain.handle('conversation-peek:open-attachment', (_event, payload: unknown): Promise<void> => {
    if (!payload || typeof payload !== 'object') return Promise.resolve()
    const { sessionId, attachmentId } = payload as { sessionId?: unknown; attachmentId?: unknown }
    if (!isId(sessionId) || !isId(attachmentId)) return Promise.resolve()
    return deps.openConversationPeekAttachment(sessionId, attachmentId)
  })
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0')
}
