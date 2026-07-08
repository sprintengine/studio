import type {
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationPermissionPreset,
} from '../../shared/conversation-runtime'

export type ConversationProviderEventStream =
  | ConversationEvent[]
  | AsyncIterable<ConversationEvent>
  | Promise<ConversationEvent[] | AsyncIterable<ConversationEvent>>

// Lifecycle inventory entry for adapters that own a child process per session
// (stateful CLI-backed providers). Consumed by the runtime's idle sweep,
// app-quit disposal, and process diagnostics.
export type ConversationProviderLiveSession = {
  sessionId: string
  workspaceId: string
  agentId: string
  workspaceRoot: string
  providerSessionId: string | null
  hasChildProcess: boolean
  childPid: number | null
  turnActive: boolean
  pendingApproval: boolean
  lastActivityAt: number
  spawnedAt: number | null
}

export type ConversationProviderAdapter = {
  id: string
  listModels(): string[]
  // 'stateless' (default when absent): the runtime owns chat history and
  // replays `[...history, user]` every turn. 'stateful': the adapter owns a
  // long-lived provider session (history, native resume, mid-turn approvals);
  // the runtime must not replay history and routes approval responses to the
  // still-active turn.
  sessions?: 'stateless' | 'stateful'
  startSession(input: MockAdapterSessionInput): ConversationProviderEventStream
  sendTurn(input: MockAdapterTurnInput): ConversationProviderEventStream
  resolveApproval(input: MockAdapterApprovalInput): ConversationProviderEventStream
  interrupt(input: MockAdapterSessionInput): ConversationProviderEventStream
  stopSession(input: MockAdapterSessionInput): ConversationProviderEventStream
  // Optional lifecycle surface for adapters holding child processes: inventory
  // for diagnostics/status, idle disposal (keeps the session + resume cursor;
  // the next turn respawns), and dispose-everything for app shutdown.
  listLiveSessions?(): ConversationProviderLiveSession[]
  disposeChildProcess?(sessionId: string): boolean
  disposeAll?(): void
}

export type MockAdapterSessionInput = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  // Stateful-session context. The runtime always passes these through from the
  // live session; they are optional so stateless adapters/tests stay minimal.
  workspaceRoot?: string
  resumeSessionId?: string
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset?: ConversationPermissionPreset
  allowedTools?: string[]
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
  // Structured answers for question-kind approvals (question text → answer).
  answers?: Record<string, string>
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
