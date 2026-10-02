// Chat conversations a module starts and drives through the host's own chat
// runtime, and the renderer's "open a chat" door onto the same thing.
//
// The event, frame and decision shapes restate @sprintengine/conversation-protocol
// exactly, and the rest restates the app's module contract; the drift guard
// pins both. The SDK depends on neither, so the published tarball stays
// self-contained and a module never pulls a second copy of the contract.

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

/**
 * A window of a conversation's log. `beforeCursor` is the first sequence the
 * page covers.
 */
export type ModuleConversationPage = {
  events: ModuleConversationEvent[]
  hasMore: boolean
  beforeCursor: number | null
}

/**
 * What `follow` delivers, in order: a `snapshot` (or, for a cursor the log
 * can vouch for, nothing), the events after it, one `synchronized` fence,
 * then live events. A snapshot with `reset: true` replaces what the module
 * held. Keep the fence's `seq` and `generation`: they are the cursor a later
 * `follow` resumes from. An `error` ends the stream.
 */
export type ModuleConversationStreamFrame =
  | { type: 'event'; event: ModuleConversationEvent }
  | { type: 'snapshot'; page: ModuleConversationPage; reset?: true; generation?: string }
  | { type: 'synchronized'; seq: number; generation?: string }
  | { type: 'error'; message: string }

/**
 * Where a `follow` starts: after `afterSeq`, in the log `generation` it was
 * read from. Absent, or a cursor the log cannot vouch for, starts from a
 * snapshot of the last `turnLimit` turns.
 */
export type ModuleConversationFollowOptions = { afterSeq?: number; generation?: string; turnLimit?: number }

/**
 * The module's own id for a mutating call. A retry with the same id is
 * answered with the first call's result and is never carried out twice, even
 * across a restart of the app. Without one, each call is its own.
 */
export type ModuleConversationCommandOptions = { commandId?: string }

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
  /** The preset the conversation runs on, or starts its next session on. */
  permissionPreset?: ModuleConversationPermissionPreset
  /** The agent CLI's own mode at that preset, when one other than the preset's own. */
  permissionMode?: string
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
 * How much the agent in a conversation does before it stops to ask:
 *
 * - `manual` asks before every edit, command, web request and MCP tool.
 * - `none` passes no permission setting, so the agent CLI follows its own
 *   configuration.
 * - `auto` edits files in the workspace without asking, and asks before
 *   anything riskier.
 * - `bypass` never asks.
 *
 * A module's conversations go no looser than `auto` unless its manifest
 * declares `conversation:bypass`; a looser preset is lowered to that ceiling,
 * not refused, and the answer names the preset in force. On `create`, absent
 * takes the user's configured default — never an escalation the module chose
 * for them.
 */
export type ModuleConversationPermissionPreset = 'none' | 'manual' | 'auto' | 'bypass'

/**
 * An answer to an approval request: allow this request `once`, allow requests
 * of its kind for the rest of the `conversation`, or `deny` it. A permanent
 * rule is the user's to make and has no answer here.
 */
export type ModuleConversationApprovalDecision = 'once' | 'conversation' | 'deny'

/** An answer to a plan the agent proposed: carry it out, or send the agent back to planning. */
export type ModuleConversationPlanDecision = 'approve' | 'reject'

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
  /**
   * The agent CLI's own mode at `permissionPreset` (Claude Code's
   * `acceptEdits`), read only beside it. Dropped when the preset is lowered to
   * the module's ceiling, and by a CLI that has no such mode.
   */
  permissionMode?: string
  /**
   * Tools the chat may use without asking, by the CLI's names for them
   * (`Write`, `Edit`). Needs `conversation:bypass`, since allowing a tool
   * without asking is as loose as bypass for that tool. They hold for the
   * session `create` starts; a session started again after the app restarts
   * asks as its preset says. A CLI that cannot take the list ignores it.
   */
  allowedTools?: string[]
  /** As `ModuleConversationCommandOptions`: a retried create finds the chat the first one made. */
  commandId?: string
}

export type ModuleConversationResult<T = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleConversationErrorCode; message: string }

/**
 * Chat conversations for a module's `entry.main`, obtained via
 * `getConversationService(host)`. A module reaches only the conversations it
 * created, never the user's own chats and never another module's.
 *
 * `conversation:read` covers `subscribe`, `follow`, `transcript`, `list` and
 * `watch`; `conversation:operate` covers everything and implies read. Check
 * `host.supports('conversations')` before relying on it, and:
 *
 * - `conversation-controls` before `setPermissionPreset`, `setModel`, a
 *   `decision` answer, or a preset other than `none` and `bypass`;
 * - `conversation-streams` before `follow` and before relying on `commandId`;
 * - `conversation-requests` before `answerQuestion` and `resolvePlan`;
 * - `conversation-permissions` before `permissionMode` and `allowedTools`.
 *
 * An older host ignores a `commandId`, `permissionMode` or `allowedTools` it
 * does not know, so check before relying on one.
 */
export type ModuleConversationService = {
  create(
    input: ModuleConversationCreateInput,
  ): Promise<ModuleConversationResult<{ conversation: ModuleConversationSummary }>>
  /** A turn on the conversation; `steer: true` lands it inside a turn that is already running. */
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
  /**
   * Answer an approval request with `decision`, or with the older `approved`
   * (true is `once`, false is `deny`). `answers` carries a question's choices.
   */
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
  /**
   * Answer a question the agent asked (an `approval_requested` event of kind
   * `question`): its text to the chosen answer. Refused for a request that is
   * not a question.
   */
  answerQuestion(
    ref: ModuleConversationRef,
    input: { requestId: string; answers: Record<string, string>; commandId?: string },
  ): Promise<ModuleConversationResult>
  /**
   * Answer a plan the agent proposed (an `approval_requested` event of kind
   * `plan`). Refused for a request that is not a plan.
   */
  resolvePlan(
    ref: ModuleConversationRef,
    input: { requestId: string; decision: ModuleConversationPlanDecision; commandId?: string },
  ): Promise<ModuleConversationResult>
  /**
   * Switch the conversation's preset, from its next tool call, and with
   * `permissionMode` to the agent CLI's own mode at it (one its CLI does not
   * have is refused, and one above the module's ceiling is dropped with the
   * preset it belonged to). Answers with the
   * preset now in force, which is the module's ceiling when it asked for more,
   * and the mode with it; `notice` says when a change applies later than at once.
   */
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
  /**
   * Switch the conversation to another model of the same agent runtime, from
   * its next turn: one of the ids `listChatRuntimes()` lists for it, or
   * `default` for the runtime's own. A runtime that binds a conversation to
   * its model refuses.
   */
  setModel(
    ref: ModuleConversationRef,
    modelId: string,
    options?: ModuleConversationCommandOptions,
  ): Promise<ModuleConversationResult<{ modelId: string; notice?: string }>>
  stop(ref: ModuleConversationRef): Promise<ModuleConversationResult>
  /** Live events from now on. Returns the unsubscriber. */
  subscribe(ref: ModuleConversationRef, cb: (event: ModuleConversationEvent) => void): () => void
  /**
   * Follow the conversation with no gap: a snapshot, or only the events after
   * a cursor the module already holds, then a `synchronized` fence, then live
   * events (see `ModuleConversationStreamFrame`). Render what you cached
   * first, then follow from its cursor. Returns the unsubscriber.
   */
  follow(
    ref: ModuleConversationRef,
    options: ModuleConversationFollowOptions | undefined,
    onFrame: (frame: ModuleConversationStreamFrame) => void,
  ): () => void
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

// What a host from before a capability answers for a method it does not
// have, instead of a TypeError the module never asked for.
function notOnThisHost(
  method: string,
  capability: string,
): Promise<{ ok: false; code: 'runtime_refused'; message: string }> {
  return Promise.resolve({
    ok: false,
    code: 'runtime_refused',
    message: `This version of the app has no "${method}"; check host.supports('${capability}').`,
  })
}

// The methods a host may be older than.
type LaterMethods = 'setPermissionPreset' | 'setModel' | 'answerQuestion' | 'resolvePlan' | 'follow'

/**
 * The scoped conversation service for `host`'s module. The raw host registry
 * takes a module id on every call; this helper closes over `host.moduleId`
 * exactly like `getModuleStorage`.
 */
export function getConversationService(host: MainHost): ModuleConversationService {
  // Partial: a host older than the SDK lacks the methods added since.
  const registry: Partial<ModuleConversationRegistry> & Omit<ModuleConversationRegistry, LaterMethods> =
    host.requireService(conversationModuleServiceToken)
  const moduleId = host.moduleId
  return {
    create: (input) => registry.create(moduleId, input),
    send: (ref, input) => registry.send(moduleId, ref, input),
    // Options are forwarded only when given, so a call without them reaches
    // any host exactly as it did before they existed.
    interrupt: (ref, options) =>
      options === undefined ? registry.interrupt(moduleId, ref) : registry.interrupt(moduleId, ref, options),
    respondToApproval: (ref, input) => registry.respondToApproval(moduleId, ref, input),
    // An older host took a question's answers on `respondToApproval`, which
    // is the same answer without the check that the request is a question.
    answerQuestion: (ref, input) =>
      registry.answerQuestion
        ? registry.answerQuestion(moduleId, ref, input)
        : registry.respondToApproval(moduleId, ref, {
            requestId: input?.requestId,
            approved: true,
            answers: input?.answers,
          }),
    resolvePlan: (ref, input) =>
      registry.resolvePlan
        ? registry.resolvePlan(moduleId, ref, input)
        : notOnThisHost('resolvePlan', 'conversation-requests'),
    setPermissionPreset: (ref, preset, options) =>
      !registry.setPermissionPreset
        ? notOnThisHost('setPermissionPreset', 'conversation-controls')
        : options === undefined
          ? registry.setPermissionPreset(moduleId, ref, preset)
          : registry.setPermissionPreset(moduleId, ref, preset, options),
    setModel: (ref, modelId, options) =>
      !registry.setModel
        ? notOnThisHost('setModel', 'conversation-controls')
        : options === undefined
          ? registry.setModel(moduleId, ref, modelId)
          : registry.setModel(moduleId, ref, modelId, options),
    stop: (ref) => registry.stop(moduleId, ref),
    subscribe: (ref, cb) => registry.subscribe(moduleId, ref, cb),
    follow: (ref, options, onFrame) => {
      if (registry.follow) return registry.follow(moduleId, ref, options, onFrame)
      onFrame({
        type: 'error',
        message: `This version of the app has no "follow"; check host.supports('conversation-streams').`,
      })
      return () => {}
    },
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
