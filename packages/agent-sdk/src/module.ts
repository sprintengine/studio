import {
  agentConversations,
  createFrameQueue,
  type AgentConversations,
  type CommandOptions,
  type ConversationFollowFrame,
  type ConversationFollowOptions,
  type ConversationListing,
  type ConversationRef,
  type ConversationResult,
  type ConversationService,
} from './conversations.js'
import { StudioError } from './errors.js'
import type {
  ConversationPlanDecision,
  ConversationQuestionAnswers,
  ConversationRequestDecision,
  ConversationWirePermissionPreset,
  StudioCreatedConversation,
  StudioCursor,
} from './protocol.js'

// The same API inside an extension's `entry.main`, over the module SDK's own
// conversation service (`getConversationService(host)`), with no socket in
// between. Code written against `AgentConversations` runs unchanged in a
// script on the socket and in an extension in process. The module's own
// rules still hold: it reaches only the chats it created, under its declared
// permissions and its ceiling.

/**
 * The module SDK's conversation service, as this adapter uses it. Structural,
 * so this package does not depend on the module SDK: pass the object
 * `getConversationService(host)` returns.
 */
export type ModuleConversationServiceLike = {
  create(
    input: Record<string, unknown>,
  ): Promise<ConversationResult<{ conversation: StudioCreatedConversation & { status?: string } }>>
  send(ref: ConversationRef, input: { message: string } & CommandOptions): Promise<ConversationResult>
  interrupt(ref: ConversationRef, options?: CommandOptions): Promise<ConversationResult>
  respondToApproval(
    ref: ConversationRef,
    input: { requestId: string; decision?: ConversationRequestDecision; approved?: boolean } & CommandOptions,
  ): Promise<ConversationResult>
  answerQuestion(
    ref: ConversationRef,
    input: { requestId: string; answers: ConversationQuestionAnswers } & CommandOptions,
  ): Promise<ConversationResult>
  resolvePlan(
    ref: ConversationRef,
    input: { requestId: string; decision: ConversationPlanDecision } & CommandOptions,
  ): Promise<ConversationResult>
  setPermissionPreset(
    ref: ConversationRef,
    preset: ConversationWirePermissionPreset,
    options?: CommandOptions & { permissionMode?: string },
  ): Promise<
    ConversationResult<{ permissionPreset: ConversationWirePermissionPreset; permissionMode?: string; notice?: string }>
  >
  setModel(
    ref: ConversationRef,
    modelId: string,
    options?: CommandOptions,
  ): Promise<ConversationResult<{ modelId: string; notice?: string }>>
  stop(ref: ConversationRef): Promise<ConversationResult>
  follow(
    ref: ConversationRef,
    options: ConversationFollowOptions | undefined,
    onFrame: (frame: ConversationFollowFrame | { type: 'error'; message: string }) => void,
  ): () => void
  list(filter?: { workspaceId?: string }): Array<{
    workspaceId: string
    agentId: string
    sessionId: string | null
    name: string
    providerId: string
    modelId: string
    permissionPreset?: ConversationWirePermissionPreset
    permissionMode?: string
  }>
}

/** `AgentConversations` (and the ref-level service) over a module's conversation service. */
export function fromModuleConversationService(
  module: ModuleConversationServiceLike,
): AgentConversations & { conversations: ConversationService } {
  const conversations: ConversationService = {
    create: (input) => module.create(input as Record<string, unknown>),
    send: (ref, input) => module.send(ref, input),
    interrupt: (ref, options) => module.interrupt(ref, options),
    respondToApproval: (ref, input) => module.respondToApproval(ref, input),
    answerQuestion: (ref, input) => module.answerQuestion(ref, input),
    resolvePlan: (ref, input) => module.resolvePlan(ref, input),
    setPermissionPreset: (ref, preset, options) => module.setPermissionPreset(ref, preset, options),
    setModel: (ref, modelId, options) => module.setModel(ref, modelId, options),
    // A module's stop takes no id: stopping is idempotent by nature.
    stop: (ref) => module.stop(ref),
    follow: (ref, options, onFrame) => module.follow(ref, options, onFrame),
    events(ref, options = {}) {
      // In process nothing drops, so there is nothing to resume: one follow,
      // its cursor kept as frames arrive and handed on as each is read.
      let cursor: StudioCursor | null = options.cursor ?? null
      let unfollow: (() => void) | null = null
      const queue = createFrameQueue({ onClose: () => unfollow?.() })
      unfollow = module.follow(
        ref,
        {
          ...(options.cursor ? { afterSeq: options.cursor.afterSeq, generation: options.cursor.generation } : {}),
          ...(options.turnLimit === undefined ? {} : { turnLimit: options.turnLimit }),
        },
        (frame) => {
          if (frame.type === 'error') {
            queue.fail(new StudioError('unavailable', frame.message))
            return
          }
          if (frame.type === 'snapshot') cursor = null
          else if (frame.type === 'synchronized' && frame.generation)
            cursor = { afterSeq: frame.seq, generation: frame.generation }
          else if (frame.type === 'event' && cursor && frame.event.seq !== undefined)
            cursor = { ...cursor, afterSeq: frame.event.seq }
          queue.push(frame, frame.type === 'snapshot' ? null : cursor ? { ...cursor } : undefined)
        },
      )
      options.signal?.addEventListener('abort', () => queue.stream.close(), { once: true })
      return queue.stream
    },
    list: async (): Promise<ConversationListing[]> =>
      module.list().map((summary) => ({
        workspaceId: summary.workspaceId,
        agentId: summary.agentId,
        title: summary.name,
        providerId: summary.providerId,
        modelId: summary.modelId,
        sessionId: summary.sessionId,
        ...(summary.permissionPreset ? { permissionPreset: summary.permissionPreset } : {}),
        ...(summary.permissionMode ? { permissionMode: summary.permissionMode } : {}),
      })),
  }
  return { ...agentConversations(conversations), conversations }
}
