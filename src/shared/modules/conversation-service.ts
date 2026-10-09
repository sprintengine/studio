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
  ConversationPermissionPreset,
  ConversationSessionStatus,
  ConversationTurnCompletedPayload,
  ConversationTurnUsage,
} from '../conversation-runtime'
import type {
  ConversationPage,
  ConversationPlanDecision,
  ConversationRequestDecision,
  ConversationStreamFrame,
} from '../../../packages/conversation-protocol/src/public'

export type ModuleConversationEventType = ConversationEventType
export type ModuleConversationEvent = ConversationEvent
export type ModuleConversationStatus = ConversationSessionStatus
export type ModuleConversationImageAttachment = ConversationImageAttachment
// The runtime's four presets. What a module may start or switch a chat to is
// capped by its grant (main/module-host/module-conversation-service.ts).
export type ModuleConversationPermissionPreset = ConversationPermissionPreset
// The protocol's answers, which bar `always`: a rule that outlives the
// conversation is the person's to make, never a module's.
export type ModuleConversationApprovalDecision = ConversationRequestDecision
export type ModuleConversationPlanDecision = ConversationPlanDecision
export type ModuleConversationPage = ConversationPage
export type ModuleConversationStreamFrame = ConversationStreamFrame
// What `turn_completed` documents about a turn: its reply text and its usage.
export type ModuleConversationTurnUsage = ConversationTurnUsage
export type ModuleConversationTurnCompletedPayload = ConversationTurnCompletedPayload

// Where a `follow` starts: after the sequence a module already holds, in the
// log generation it read it from. Absent, from a snapshot.
export type ModuleConversationFollowOptions = { afterSeq?: number; generation?: string; turnLimit?: number }

// A module's own id for a mutating call. A retry with the same id is answered
// with the first call's result, and never carried out twice.
export type ModuleConversationCommandOptions = { commandId?: string }

export type ModuleConversationRef = { workspaceId: string; agentId: string }

export type ModuleConversationSummary = ModuleConversationRef & {
  sessionId: string | null
  name: string
  cli: string
  providerId: string
  modelId: string
  status: ModuleConversationStatus | 'absent'
  // The live session's preset, else the one the chat's record starts it on.
  permissionPreset?: ModuleConversationPermissionPreset
  // The CLI's own mode at that preset, when one other than the preset's own.
  permissionMode?: string
}

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
  // `reply`: the conversation has no finished turn (with that id).
  | 'no_reply'

export type ModuleConversationCreateInput = {
  workspaceId: string
  cli?: string
  model?: string
  prompt?: string
  skills?: string[]
  attachments?: ModuleConversationImageAttachment[]
  permissionPreset?: ModuleConversationPermissionPreset
  name?: string
  // The CLI's own mode at `permissionPreset`; read only beside it.
  permissionMode?: string
  // Tools the chat may use without asking. Needs `conversation:bypass`.
  allowedTools?: string[]
  commandId?: string
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
    input: {
      message: string
      skills?: string[]
      attachments?: ModuleConversationImageAttachment[]
      steer?: boolean
      commandId?: string
    },
  ): Promise<ModuleConversationResult>
  interrupt(ref: ModuleConversationRef, options?: ModuleConversationCommandOptions): Promise<ModuleConversationResult>
  // `decision`, or the older `approved` (true is `once`, false is `deny`).
  respondToApproval(
    ref: ModuleConversationRef,
    input: {
      requestId: string
      decision?: ModuleConversationApprovalDecision
      approved?: boolean
      answers?: Record<string, string>
      commandId?: string
    },
  ): Promise<ModuleConversationResult>
  // A question's answers; refused for a request that is not a question.
  answerQuestion(
    ref: ModuleConversationRef,
    input: { requestId: string; answers: Record<string, string>; commandId?: string },
  ): Promise<ModuleConversationResult>
  // A plan carried out or sent back; refused for a request that is not a plan.
  resolvePlan(
    ref: ModuleConversationRef,
    input: { requestId: string; decision: ModuleConversationPlanDecision; commandId?: string },
  ): Promise<ModuleConversationResult>
  // Answers with the preset now in force, which is lower than the one asked
  // for when the module's grant caps it, and the CLI's mode with it.
  setPermissionPreset(
    ref: ModuleConversationRef,
    preset: ModuleConversationPermissionPreset,
    options?: ModuleConversationCommandOptions & { permissionMode?: string },
  ): Promise<
    ModuleConversationResult<{
      permissionPreset: ModuleConversationPermissionPreset
      permissionMode?: string
      notice?: string
    }>
  >
  setModel(
    ref: ModuleConversationRef,
    modelId: string,
    options?: ModuleConversationCommandOptions,
  ): Promise<ModuleConversationResult<{ modelId: string; notice?: string }>>
  stop(ref: ModuleConversationRef): Promise<ModuleConversationResult>
  subscribe(ref: ModuleConversationRef, cb: (event: ModuleConversationEvent) => void): () => void
  // A snapshot (or, for a cursor the log can vouch for, only the missed
  // events), then one `synchronized` fence, then live events.
  follow(
    ref: ModuleConversationRef,
    options: ModuleConversationFollowOptions | undefined,
    onFrame: (frame: ModuleConversationStreamFrame) => void,
  ): () => void
  transcript(ref: ModuleConversationRef): Promise<ModuleConversationResult<{ events: ModuleConversationEvent[] }>>
  // The reply of a finished turn (the last one, or `turnId`'s), read off the transcript.
  reply(ref: ModuleConversationRef, turnId?: string): Promise<ModuleConversationResult<{ turnId: string; text: string }>>
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

// ── Headless text generation (main) ──────────────────────────────────────────
// One prompt answered by the person's own agent CLI with no workspace, no
// tools and no tab (main/text-generation/module-text-generation.ts).

export type ModuleTextGenerationInput = {
  prompt: string
  system?: string
  model?: string
  maxOutputTokens?: number
  json?: boolean
  cli?: string
}

export type ModuleTextGenerationErrorCode =
  | 'permission_missing'
  | 'invalid_input'
  | 'unsupported'
  | 'unavailable'
  | 'busy'
  | 'timeout'
  | 'failed'
  | 'invalid_output'

export type ModuleTextGenerationResult =
  | { ok: true; text: string; usage: ModuleConversationTurnUsage; model: string }
  | { ok: false; code: ModuleTextGenerationErrorCode; message: string }

export type ModuleTextGenerationService = {
  generate(input: ModuleTextGenerationInput): Promise<ModuleTextGenerationResult>
}

// What the host provides under 'text-generation.module-service'.
export type ModuleTextGenerationRegistry = {
  generate(moduleId: string, input: ModuleTextGenerationInput): Promise<ModuleTextGenerationResult>
}
