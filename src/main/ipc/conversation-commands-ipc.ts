import { join } from 'node:path'
import type { IpcMain } from 'electron'

import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import type { ConversationCliRuntimeOverrides } from '../../shared/conversation-runtime'
import {
  CONVERSATION_COMMANDS_CHANGED_CHANNEL,
  CONVERSATION_COMMANDS_LIST_CHANNEL,
} from '../../shared/ipc/conversation-commands'
import {
  CONVERSATION_COMMANDS_CACHE_FILE,
  createConversationCommandsDiskCache,
} from '../conversation-commands/disk-cache'
import { onConversationCommandsChanged } from '../conversation-commands/registry'
import { readConversationCommandsRequest } from '../conversation-commands/request'
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

export { readConversationCommandsRequest }

export type ConversationCommandsIpcHandle = {
  /** The list main holds for a (CLI, folder), as the channel answers it; the Studio RPC asks through this too. */
  list: ConversationCommandsService['list']
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
  return { list: (input) => service.list(input), stop, dispose: () => service.dispose() }
}
