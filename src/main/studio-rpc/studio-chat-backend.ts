import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import type { ConversationCommandsRequest } from '../../shared/ipc/conversation-commands'
import type { FileSearchResult, FileSystemStat } from '../../shared/ipc/filesystem'
import type { StudioChatBackend } from '../../server/rpc/studio-rpc-types'
import { onConversationCommandsChanged } from '../conversation-commands/registry'
import { readConversationCommandsRequest } from '../conversation-commands/request'
import {
  parseProviderInput,
  parseRespondToRequestInput,
  parseSendTurnInput,
  parseSessionIdInput,
  parseSetModelInput,
  parseSetPermissionInput,
  parseStartSessionInput,
} from '../conversation-ipc-inputs'
import type { ConversationIpcHandlers } from '../ipc/conversation-ipc'

// The Studio RPC's chat surface in main: the very handlers the conversation
// IPC serves Studio's windows with, behind the same input checks
// (conversation-ipc-inputs.ts) and the same fallbacks, so a chat view reaching
// them over a port is answered exactly as one reaching them over IPC. Nothing
// here is new behaviour; where an IPC handler wraps a throw into
// `{ ok: false, message }`, so does this.
//
// One difference is the command id. A window's IPC sends none; the RPC's
// session commands carry the client's, namespaced (`owner:<id>`), and it is
// passed to the runtime, whose receipts answer a command repeated after a
// dropped connection with its first result.

type ChatHandlers = Pick<
  ConversationIpcHandlers,
  | 'startSession'
  | 'sendTurn'
  | 'interrupt'
  | 'respondToRequest'
  | 'setPermission'
  | 'setModel'
  | 'revertToTurn'
  | 'rewindToTurn'
  | 'forkAtTurn'
  | 'readAttachment'
  | 'planDocument'
  | 'listProviders'
  | 'listProviderModels'
  | 'getSecretStatus'
>

export type StudioChatBackendDeps = {
  conversation: ChatHandlers
  /** File search and reads, as the filesystem IPC serves them; a slot stands where a window's id would. */
  files: {
    searchFiles(senderId: number, input: Parameters<StudioChatBackend['searchFiles']>[1]): Promise<FileSearchResult>
    cancelActiveFileSearch(senderId: number, channel?: string): void
    cancelAllFileSearches(senderId: number): void
    statPath(path: string): Promise<FileSystemStat>
    readImageDataUrl(path: string): Promise<string>
  }
  repoRoot(folderPath: string, hostId?: string): Promise<string | null>
  /** The (CLI, folder) list main holds, probing when it is missing or old. */
  commands(input: ConversationCommandsRequest): Promise<ConversationCommandCatalog>
  onCommandsChanged?: (listener: (catalog: ConversationCommandCatalog) => void) => () => void
  workspaces(): ReturnType<StudioChatBackend['workspaces']>
}

const failed = (error: unknown): { ok: false; message: string } => ({
  ok: false,
  message: error instanceof Error ? error.message : String(error),
})

/**
 * A session input checked as the IPC checks it. The IPC takes a command id
 * only as a UUID, from a window; the RPC's is namespaced to its client, so it
 * is set aside for the check and put back after.
 */
function checked<T extends { commandId?: string }>(
  input: T,
  parse: (
    raw: unknown,
  ) => { ok: true; input: Omit<T, 'commandId'> & { commandId?: string } } | { ok: false; message: string },
): { ok: true; input: T } | { ok: false; message: string } {
  const { commandId, ...rest } = input
  const parsed = parse(rest)
  if (!parsed.ok) return parsed
  return { ok: true, input: { ...parsed.input, ...(commandId === undefined ? {} : { commandId }) } as T }
}

export function createStudioChatBackend(deps: StudioChatBackendDeps): StudioChatBackend {
  const handlers = deps.conversation
  const onCommandsChanged = deps.onCommandsChanged ?? onConversationCommandsChanged
  return {
    async startSession(input) {
      const parsed = parseStartSessionInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.startSession(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async sendTurn(input) {
      const parsed = checked(input, parseSendTurnInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.sendTurn(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async interrupt(input) {
      const parsed = checked(input, parseSessionIdInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.interrupt(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async respond(input) {
      const parsed = checked(input, parseRespondToRequestInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.respondToRequest(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async setPermission(input) {
      const parsed = checked(input, parseSetPermissionInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.setPermission(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async setModel(input) {
      const parsed = checked(input, parseSetModelInput)
      if (!parsed.ok) return parsed
      if (!handlers.setModel) return { ok: false, message: 'Changing models mid-conversation is unavailable.' }
      try {
        return await handlers.setModel(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async revert(input) {
      return (await handlers.revertToTurn?.(input)) ?? { ok: false, message: 'Checkpoints are unavailable.' }
    },
    async rewind(input) {
      return (
        (await handlers.rewindToTurn?.(input)) ?? { ok: false, message: 'Editing an earlier message is unavailable.' }
      )
    },
    async fork(input) {
      return (await handlers.forkAtTurn?.(input)) ?? { ok: false, message: 'Forking a conversation is unavailable.' }
    },
    async attachment(ref) {
      return (await handlers.readAttachment?.(ref)) ?? { ok: false, message: 'Attachments are unavailable.' }
    },
    async planDocument(input) {
      try {
        return (await handlers.planDocument?.(input)) ?? { ok: false, message: 'Plans are unavailable.' }
      } catch (error) {
        return failed(error)
      }
    },
    async commands(raw) {
      const input = readConversationCommandsRequest(raw)
      if (!input) throw new Error('A command list is asked for with a chat CLI and an absolute folder.')
      return deps.commands(input)
    },
    onCommandsChanged: (listener) => onCommandsChanged(listener),
    async providers(input) {
      try {
        return await handlers.listProviders(input)
      } catch (error) {
        return failed(error)
      }
    },
    async providerModels(input) {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.listProviderModels(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async secretStatus(input) {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.getSecretStatus(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    searchFiles: (slot, input) => deps.files.searchFiles(slot, input),
    cancelFileSearch: (slot, channel) => deps.files.cancelActiveFileSearch(slot, channel),
    releaseFileSearches: (slot) => deps.files.cancelAllFileSearches(slot),
    stat: (path) => deps.files.statPath(path),
    readImage: (path) => deps.files.readImageDataUrl(path),
    repoRoot: (folderPath, hostId) => deps.repoRoot(folderPath, hostId),
    workspaces: () => deps.workspaces(),
  }
}
