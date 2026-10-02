import type { ConversationCommandCatalog } from '../../../../../shared/conversation/commands'
import type {
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationProvidersListInput,
} from '../../../../../shared/conversation-runtime'
import type {
  ConversationProviderListResult,
  ConversationProviderModelsInput,
  ConversationProviderModelsResult,
  ConversationSecretStatusInput,
  ConversationSecretStatusResult,
  FileSearchResult,
  FileSystemStat,
} from '../../../../../shared/electron-api'
import type { ConversationCommandsRequest } from '../../../../../shared/ipc/conversation-commands'

// What a chat view asks of the Studio its window belongs to, whichever machine
// the chat itself runs on: the providers and models it can pick, the files its
// mentions, links and pictures name, a plan opened as a document, and the `/`
// command lists its CLI reports. A chat followed from a paired machine still
// reads these here, as it always has.
//
// Two implementations answer the same calls: the window's IPC, and the Studio
// protocol (`studioChat.ts`). Which one a window uses is decided once, by
// `window.api.studioChatTransport`, and read at call time so a test's stub is
// the one used.

export type ChatProviderSource = {
  list(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult>
  models(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult>
  secretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult>
}

export type ChatFileSearchOptions = {
  limit?: number
  purpose?: 'mention'
  channel?: string
  recentAt?: Record<string, number>
}

export type ChatFileSource = {
  /** Whether this window can ask about a path at all; a preload too old to say leaves links as they read. */
  readonly canStat: boolean
  search(rootPath: string, query: string, options?: ChatFileSearchOptions): Promise<FileSearchResult>
  cancelSearch(channel?: string): Promise<void>
  /** Rejects as the IPC does when the path cannot be read. */
  stat(path: string): Promise<FileSystemStat>
  readImage(path: string): Promise<string>
  repoRoot(folderPath: string, hostId?: string): Promise<string | null>
}

/** Absent members are a build that does not list a CLI's commands: the menu keeps Studio's own. */
export type ChatCommandSource = {
  list?: (input: ConversationCommandsRequest) => Promise<ConversationCommandCatalog>
  /** Every list published from now on, for whichever (CLI, folder). */
  onChanged?: (listener: (catalog: ConversationCommandCatalog) => void) => () => void
}

export type ChatServices = {
  providers: ChatProviderSource
  files: ChatFileSource
  planDocument(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult>
  commands: ChatCommandSource
}

type CommandsApi = {
  conversationCommands?: (input: ConversationCommandsRequest) => Promise<ConversationCommandCatalog>
  onConversationCommandsChanged?: (listener: (catalog: ConversationCommandCatalog) => void) => () => void
}
// A build whose preload does not expose the command list yet leaves the menu
// with Studio's own commands rather than throwing.
const commandsApi = (): CommandsApi =>
  (typeof window === 'undefined' ? {} : (window.api as unknown as CommandsApi | undefined)) ?? {}

/** The window's IPC, read off `window.api` at call time. */
export const ipcChatServices: ChatServices = {
  // A preload from before the providers were listed over IPC answers as the
  // view has always worded it, rather than throwing.
  providers: {
    list: async (input) =>
      typeof window.api.conversationProvidersList === 'function'
        ? window.api.conversationProvidersList(input)
        : { ok: false, message: 'Conversation providers need an app restart before this agent is available.' },
    models: async (input) =>
      typeof window.api.conversationProviderModels === 'function'
        ? window.api.conversationProviderModels(input)
        : { ok: false, message: 'Model lists need an app restart.' },
    secretStatus: async (input) =>
      typeof window.api.conversationSecretStatus === 'function'
        ? window.api.conversationSecretStatus(input)
        : { ok: false, message: 'Key status needs an app restart.' },
  },
  // Async throughout, so a member a preload lacks rejects like a failed call
  // instead of throwing where the caller only handles a rejection.
  files: {
    get canStat() {
      return typeof window !== 'undefined' && typeof window.api?.statPath === 'function'
    },
    search: async (rootPath, query, options) => window.api.searchFiles(rootPath, query, options),
    cancelSearch: async (channel) => window.api.cancelFileSearch?.(channel),
    stat: async (path) => window.api.statPath(path),
    readImage: async (path) => window.api.readImageDataUrl(path),
    repoRoot: async (folderPath, hostId) => window.api.getGitRepoRoot(folderPath, hostId),
  },
  planDocument: async (input) => window.api.conversationPlanDocument(input),
  commands: {
    get list() {
      return commandsApi().conversationCommands
    },
    get onChanged() {
      return commandsApi().onConversationCommandsChanged
    },
  },
}
