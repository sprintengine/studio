import { isAbsolute, join } from 'node:path'
import type { IpcMain } from 'electron'

import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import { conversationProviderForCli } from '../../shared/conversation-harness'
import type { ConversationCliRuntimeOverrides } from '../../shared/conversation-runtime'
import {
  CONVERSATION_COMMANDS_CHANGED_CHANNEL,
  CONVERSATION_COMMANDS_LIST_CHANNEL,
  type ConversationCommandsRequest,
} from '../../shared/ipc/conversation-commands'
import { isRecord } from '../../shared/records'
import {
  CONVERSATION_COMMANDS_CACHE_FILE,
  createConversationCommandsDiskCache,
} from '../conversation-commands/disk-cache'
import { onConversationCommandsChanged } from '../conversation-commands/registry'
import { createConversationCommandsService, type ConversationCommandsService } from '../conversation-commands/service'

/** The slice of a renderer's webContents the push touches. */
type SubscriberLike = {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
  once: (event: 'destroyed', listener: () => void) => unknown
}

export type ConversationCommandsIpcDeps = {
  service?: ConversationCommandsService
  /** Where the last good lists are kept across restarts (the app's userData). */
  userDataDir?: string
  /** The person's per-CLI command and WSL overrides, which main owns. */
  cliRuntimes?: () => ConversationCliRuntimeOverrides | undefined
}

// The renderer names a CLI and a folder; anything else is refused here rather
// than handed to a probe that would start a process with it. The CLI must be
// one a chat can ride, and the folder an absolute path.
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

export type ConversationCommandsIpcHandle = {
  /** Stop relaying pushes; for tests. */
  stop: () => void
  /** Stop recording into the disk cache and write what is pending; for quit. */
  dispose: () => Promise<void>
}

/**
 * `conversation-commands:list` answers with the (CLI, folder) list main holds,
 * starting a probe when it is missing or old; every list published afterwards
 * — that probe's, a live session's, an ACP update's — is pushed to every
 * renderer that has asked for one, so a chat that did not ask (another window,
 * a background chat) is current too. A renderer that never asked has no chat
 * reading a list (every chat asks as it mounts), so the canvas worker and the
 * windows without a composer are not woken for each list a live chat reports.
 */
export function registerConversationCommandsIpc(
  ipcMain: IpcMain,
  deps: ConversationCommandsIpcDeps = {},
): ConversationCommandsIpcHandle {
  const service =
    deps.service ??
    createConversationCommandsService({
      cliRuntimes: deps.cliRuntimes,
      cache: deps.userDataDir
        ? createConversationCommandsDiskCache({ file: join(deps.userDataDir, CONVERSATION_COMMANDS_CACHE_FILE) })
        : null,
    })
  const subscribers = new Map<number, SubscriberLike>()
  const subscribe = (sender: SubscriberLike | undefined): void => {
    if (!sender || subscribers.has(sender.id) || sender.isDestroyed()) return
    subscribers.set(sender.id, sender)
    sender.once('destroyed', () => subscribers.delete(sender.id))
  }
  ipcMain.handle(CONVERSATION_COMMANDS_LIST_CHANNEL, async (event, raw?: unknown) => {
    const input = readConversationCommandsRequest(raw)
    if (!input) throw new Error('A command list is asked for with a chat CLI and an absolute folder.')
    subscribe((event as { sender?: SubscriberLike } | null)?.sender)
    return service.list(input)
  })
  const stopRelay = onConversationCommandsChanged((catalog: ConversationCommandCatalog) => {
    for (const [id, sender] of subscribers) {
      if (sender.isDestroyed()) subscribers.delete(id)
      else sender.send(CONVERSATION_COMMANDS_CHANGED_CHANNEL, catalog)
    }
  })
  const stop = (): void => {
    stopRelay()
    subscribers.clear()
  }
  return { stop, dispose: () => service.dispose() }
}
