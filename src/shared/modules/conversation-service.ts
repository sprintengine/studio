// The module-facing conversation contract: the chats a module starts and drives
// through the host's own chat runtime (main), and the renderer's "open a chat"
// door onto the same thing.
//
// The event, status and attachment shapes ARE the runtime's own, so a module
// sees exactly what the chat view sees; the SDK restates them by hand and the
// drift guard pins the two together. Everything else is declared here and
// mirrored there.

import type {
  ConversationEvent,
  ConversationEventType,
  ConversationImageAttachment,
  ConversationSessionStatus,
} from '../conversation-runtime'

export type ModuleConversationEventType = ConversationEventType
export type ModuleConversationEvent = ConversationEvent
export type ModuleConversationStatus = ConversationSessionStatus
export type ModuleConversationImageAttachment = ConversationImageAttachment

export type ModuleConversationRef = { workspaceId: string; agentId: string }

export type ModuleConversationSummary = ModuleConversationRef & {
  sessionId: string | null
  name: string
  cli: string
  providerId: string
  modelId: string
  status: ModuleConversationStatus | 'absent'
}

export type ModuleConversationPermissionPreset = 'none' | 'bypass'

export type ModuleConversationErrorCode =
  | 'permission_missing'
  | 'invalid_input'
  | 'unknown_workspace'
  | 'workspace_folder_missing'
  | 'no_cli_selected'
  | 'cli_not_conversational'
  | 'unknown_skill'
  | 'not_owned'
  | 'agent_write_failed'
  | 'conversation_start_failed'
  | 'runtime_refused'

export type ModuleConversationCreateInput = {
  workspaceId: string
  cli?: string
  model?: string
  prompt?: string
  skills?: string[]
  attachments?: ModuleConversationImageAttachment[]
  permissionPreset?: ModuleConversationPermissionPreset
  name?: string
}

export type ModuleConversationResult<T = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleConversationErrorCode; message: string }

// `conversation:read` covers subscribe/transcript/list/watch; `conversation:operate`
// covers everything and implies read. A module reaches only the conversations
// it created.
export type ModuleConversationService = {
  create(
    input: ModuleConversationCreateInput,
  ): Promise<ModuleConversationResult<{ conversation: ModuleConversationSummary }>>
  send(
    ref: ModuleConversationRef,
    input: { message: string; skills?: string[]; attachments?: ModuleConversationImageAttachment[]; steer?: boolean },
  ): Promise<ModuleConversationResult>
  interrupt(ref: ModuleConversationRef): Promise<ModuleConversationResult>
  respondToApproval(
    ref: ModuleConversationRef,
    input: { requestId: string; approved: boolean; answers?: Record<string, string> },
  ): Promise<ModuleConversationResult>
  stop(ref: ModuleConversationRef): Promise<ModuleConversationResult>
  subscribe(ref: ModuleConversationRef, cb: (event: ModuleConversationEvent) => void): () => void
  transcript(ref: ModuleConversationRef): Promise<ModuleConversationResult<{ events: ModuleConversationEvent[] }>>
  list(filter?: { workspaceId?: string }): ModuleConversationSummary[]
  watch(
    filter: { workspaceId?: string } | undefined,
    cb: (conversations: ModuleConversationSummary[]) => void,
  ): () => void
}

// What the host provides under 'conversation.module-service': the published
// service with the calling module's id first, which the SDK helper closes over.
export type ModuleConversationRegistry = {
  [K in keyof ModuleConversationService]: (
    moduleId: string,
    ...args: Parameters<ModuleConversationService[K]>
  ) => ReturnType<ModuleConversationService[K]>
}

// ── Opening a chat from the renderer ─────────────────────────────────────────

export type ModuleOpenChatInput = {
  workspaceId: string
  prompt?: string
  skills?: string[]
  cli?: string
  model?: string
  // Default false: the prompt lands in the composer as a draft.
  send?: boolean
}

export type ModuleOpenChatResult =
  | { ok: true; agentId: string }
  | {
      ok: false
      code:
        | 'permission_missing'
        | 'unknown_workspace'
        | 'workspace_folder_missing'
        | 'cli_not_conversational'
        | 'unavailable'
      message: string
    }

export type ModuleChatRuntimeOption = {
  id: string
  label: string
  available: boolean
  models: { id: string; label: string }[]
  lastSelected: boolean
}
