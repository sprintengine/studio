import { isAbsolute } from 'node:path'

import { conversationProviderForCli } from '../../shared/conversation-harness'
import type { ConversationCommandsRequest } from '../../shared/ipc/conversation-commands'
import { isRecord } from '../../shared/records'

// A chat names a CLI and a folder; anything else is refused here rather than
// handed to a probe that would start a process with it. The CLI must be one a
// chat can ride, and the folder an absolute path. The IPC and the Studio RPC's
// chat surface both read a request through this.
export function readConversationCommandsRequest(raw: unknown): ConversationCommandsRequest | null {
  if (!isRecord(raw) || typeof raw.cli !== 'string' || typeof raw.cwd !== 'string') return null
  if (!conversationProviderForCli(raw.cli)) return null
  if (!raw.cwd || raw.cwd.length > 4096 || raw.cwd.includes('\0') || !isAbsolute(raw.cwd)) return null
  return {
    cli: raw.cli,
    cwd: raw.cwd,
    ...(raw.refresh === true ? { refresh: true } : {}),
    ...(raw.probe === false ? { probe: false as const } : {}),
  }
}
