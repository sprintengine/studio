// Chat conversations a module starts and drives through the host's own chat
// runtime, and the renderer's "open a chat" door onto the same thing.
//
// The event and attachment shapes restate the app's conversation-runtime
// contracts exactly (the drift guard pins them); the SDK never imports app
// code, so the published tarball stays self-contained.

import type { MainHost, ServiceToken } from './index.js'

/** Every kind of event a chat conversation records, in the host's own vocabulary. */
export type ModuleConversationEventType =
  | 'session_started'
  | 'session_ready'
  | 'session_closed'
  | 'session_updated'
  | 'user_message'
  | 'turn_started'
  | 'content_delta'
  | 'reasoning_delta'
  | 'tool_started'
  | 'tool_output'
  | 'approval_requested'
  | 'approval_resolved'
  | 'usage_updated'
  | 'context_compacted'
  | 'command_output'
  | 'turn_completed'
  | 'turn_failed'
  | 'subagent_status'
  | 'subagent_message'

/** One event of a conversation, as it streams and as its transcript replays it. */
export type ModuleConversationEvent = {
  id: string
  /** Order within the session; absent only on events recorded before the host stamped one. */
  seq?: number
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  type: ModuleConversationEventType
  createdAt: number
  payload?: Record<string, unknown>
}

export type ModuleConversationStatus = 'starting' | 'ready' | 'active' | 'awaiting_approval' | 'stopped' | 'failed'

/** How a module addresses one of its conversations again. */
export type ModuleConversationRef = { workspaceId: string; agentId: string }

export type ModuleConversationSummary = ModuleConversationRef & {
  /** Null until the runtime has started a session for the conversation. */
  sessionId: string | null
  name: string
  cli: string
  providerId: string
  modelId: string
  /** `absent` when the conversation exists but no session is running for it. */
  status: ModuleConversationStatus | 'absent'
}

/**
 * An image handed to a turn. `dataBase64` is the raw base64 payload (no
 * `data:` prefix); `mediaType` is the image MIME type.
 */
export type ModuleConversationImageAttachment = {
  id: string
  mediaType: string
  dataBase64: string
  name?: string
  byteLength: number
}

/**
 * The launch permission preset. Absent takes the user's configured default —
 * never an escalation the module chose for them.
 */
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
  /** Agent runtime id; absent takes the user's last-selected one. */
  cli?: string
  model?: string
  /** Sent as the opening turn. Absent starts the conversation without one. */
  prompt?: string
  /** Skill ids the host installs before the first turn and invokes in it. */
  skills?: string[]
  attachments?: ModuleConversationImageAttachment[]
  permissionPreset?: ModuleConversationPermissionPreset
  /** Display name; absent picks one from the shared pool. */
  name?: string
}

export type ModuleConversationResult<T = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleConversationErrorCode; message: string }

/**
 * Chat conversations for a module's `entry.main`, obtained via
 * `getConversationService(host)`. A module reaches only the conversations it
 * created, never the user's own chats and never another module's.
 *
 * `conversation:read` covers `subscribe`, `transcript`, `list` and `watch`;
 * `conversation:operate` covers everything and implies read. Check
 * `host.supports('conversations')` before relying on it.
 */
export type ModuleConversationService = {
  create(
    input: ModuleConversationCreateInput,
  ): Promise<ModuleConversationResult<{ conversation: ModuleConversationSummary }>>
  /** A turn on the conversation; `steer: true` lands it inside a turn that is already running. */
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
  /** Live events from now on. Returns the unsubscriber. */
  subscribe(ref: ModuleConversationRef, cb: (event: ModuleConversationEvent) => void): () => void
  transcript(ref: ModuleConversationRef): Promise<ModuleConversationResult<{ events: ModuleConversationEvent[] }>>
  list(filter?: { workspaceId?: string }): ModuleConversationSummary[]
  /** `cb` fires once with the current list, then on every change. Returns the unsubscriber. */
  watch(
    filter: { workspaceId?: string } | undefined,
    cb: (conversations: ModuleConversationSummary[]) => void,
  ): () => void
}

// The moduleId-first registry the app provides; derived from the published
// service so the two shapes cannot drift.
type ModuleConversationRegistry = {
  [K in keyof ModuleConversationService]: (
    moduleId: string,
    ...args: Parameters<ModuleConversationService[K]>
  ) => ReturnType<ModuleConversationService[K]>
}

// A literal rather than createServiceToken: index.ts re-exports this file, and
// a value import back into it would be a cycle for nothing (a token is its key).
const conversationModuleServiceToken: ServiceToken<ModuleConversationRegistry> = {
  key: 'conversation.module-service',
}

/**
 * The scoped conversation service for `host`'s module. The raw host registry
 * takes a module id on every call; this helper closes over `host.moduleId`
 * exactly like `getModuleStorage`.
 */
export function getConversationService(host: MainHost): ModuleConversationService {
  const registry = host.requireService(conversationModuleServiceToken)
  const moduleId = host.moduleId
  return {
    create: (input) => registry.create(moduleId, input),
    send: (ref, input) => registry.send(moduleId, ref, input),
    interrupt: (ref) => registry.interrupt(moduleId, ref),
    respondToApproval: (ref, input) => registry.respondToApproval(moduleId, ref, input),
    stop: (ref) => registry.stop(moduleId, ref),
    subscribe: (ref, cb) => registry.subscribe(moduleId, ref, cb),
    transcript: (ref) => registry.transcript(moduleId, ref),
    list: (filter) => registry.list(moduleId, filter),
    watch: (filter, cb) => registry.watch(moduleId, filter, cb),
  }
}

// ── Opening a chat from the renderer ─────────────────────────────────────────

export type ModuleOpenChatInput = {
  workspaceId: string
  prompt?: string
  skills?: string[]
  /** Agent runtime id from `listChatRuntimes()`; absent takes the user's last-selected one. */
  cli?: string
  model?: string
  /**
   * Send the prompt as the chat's first turn. Default false: the prompt lands
   * in the composer as a draft the user reads and sends themselves.
   */
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

/** One agent runtime a chat can run on, as a picker row. */
export type ModuleChatRuntimeOption = {
  /** Runtime id to pass as `openChat`'s `cli` (e.g. 'claude', 'codex'). */
  id: string
  label: string
  /** Whether this machine has the runtime; missing ones are listed so a picker can show them disabled. */
  available: boolean
  /** Empty when the runtime offers no model choice. */
  models: { id: string; label: string }[]
  /** True for the runtime the user last chose — what a picker should preselect. */
  lastSelected: boolean
}
