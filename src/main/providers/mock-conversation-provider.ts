import type { ConversationEvent } from '../../shared/conversation-runtime'

export type ConversationProviderEventStream =
  | ConversationEvent[]
  | AsyncIterable<ConversationEvent>
  | Promise<ConversationEvent[] | AsyncIterable<ConversationEvent>>

export type ConversationProviderAdapter = {
  id: string
  listModels(): string[]
  startSession(input: MockAdapterSessionInput): ConversationProviderEventStream
  sendTurn(input: MockAdapterTurnInput): ConversationProviderEventStream
  resolveApproval(input: MockAdapterApprovalInput): ConversationProviderEventStream
  interrupt(input: MockAdapterSessionInput): ConversationProviderEventStream
  stopSession(input: MockAdapterSessionInput): ConversationProviderEventStream
}

export type MockAdapterSessionInput = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
}

export type ConversationMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type MockAdapterTurnInput = MockAdapterSessionInput & {
  turnId: string
  requestId: string
  message: string
  // Full chat history including the current user turn, in send order. Providers
  // that support multi-turn context send this; absent for legacy/mock callers,
  // who fall back to the single `message`.
  messages?: ConversationMessage[]
  signal?: AbortSignal
}

export type MockAdapterApprovalInput = MockAdapterSessionInput & {
  turnId: string
  requestId: string
  approved: boolean
}

export function createMockConversationProvider(): ConversationProviderAdapter {
  return {
    id: 'mock-provider',
    listModels: () => ['mock-model'],
    startSession(input) {
      return [
        event(input, 'session_started'),
        event(input, 'session_ready'),
      ]
    },
    sendTurn(input) {
      return [
        event(input, 'turn_started', { turnId: input.turnId }),
        event(input, 'content_delta', { turnId: input.turnId, text: `Mock response for: ${input.message}` }),
        event(input, 'approval_requested', {
          turnId: input.turnId,
          requestId: input.requestId,
          action: 'mock_approval',
          summary: 'Mock provider requests approval to complete the turn.',
        }),
      ]
    },
    resolveApproval(input) {
      if (!input.approved) {
        return [
          event(input, 'approval_resolved', { turnId: input.turnId, requestId: input.requestId, approved: false }),
          event(input, 'turn_failed', { turnId: input.turnId, reason: 'approval_denied' }),
        ]
      }
      return [
        event(input, 'approval_resolved', { turnId: input.turnId, requestId: input.requestId, approved: true }),
        event(input, 'usage_updated', { turnId: input.turnId, inputTokens: 4, outputTokens: 8 }),
        event(input, 'turn_completed', { turnId: input.turnId }),
      ]
    },
    interrupt(input) {
      return [event(input, 'turn_failed', { reason: 'interrupted' })]
    },
    stopSession(input) {
      return [event(input, 'session_closed')]
    },
  }
}

function event(
  input: MockAdapterSessionInput,
  type: ConversationEvent['type'],
  payload?: Record<string, unknown>
): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload,
  }
}
