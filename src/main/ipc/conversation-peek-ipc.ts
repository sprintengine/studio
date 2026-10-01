import type { IpcMain } from 'electron'

import type { ConversationPeek } from '../../shared/conversation-peek'

/**
 * The channel behind the conversation peek: read-only, keyed by the terminal
 * session the card is anchored to.
 *
 * The payload is validated here rather than trusted: a renderer is the least
 * trusted caller main has. A malformed read answers with the `unknown` peek —
 * a state the card already renders — rather than throwing, so a hover can
 * never surface an error dialog.
 */
export type ConversationPeekIpcDependencies = {
  readConversationPeek(sessionId: string): Promise<ConversationPeek>
}

/** Cap on an id off the wire. Session ids are uuid-shaped; this is an abuse guard. */
const MAX_ID_LENGTH = 512

export function registerConversationPeekIpc(ipcMain: IpcMain, deps: ConversationPeekIpcDependencies): void {
  ipcMain.handle('conversation-peek:read', (_event, sessionId: unknown): Promise<ConversationPeek> => {
    // A malformed payload is our bug or a hostile caller — never a statement
    // about the runtime, so `unknown` rather than the `none` that would tell
    // the person their CLI cannot report messages.
    if (!isId(sessionId)) {
      return Promise.resolve({ sessionId: '', source: 'unknown' as const, first: null, since: [] })
    }
    return deps.readConversationPeek(sessionId)
  })
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0')
}
