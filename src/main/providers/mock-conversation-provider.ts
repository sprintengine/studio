import type { ConversationEvent, ConversationCapabilities } from '../../shared/conversation-runtime'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './conversation-provider-adapter'
import { inferConversationToolKind } from '../../shared/conversation/toolKind'
export type * from './conversation-provider-adapter'

export const MOCK_CONVERSATION_CAPABILITIES: ConversationCapabilities = {
  tools: true,
  approvals: true,
  questions: true,
  planMode: true,
  images: true,
  skills: 'native',
  reasoningEfforts: null,
  interrupt: true,
  resume: false,
  subagents: true,
  cost: false,
  contextMeter: false,
  liveModelSwitch: false,
}

export function createMockConversationProvider(
  capabilities: Partial<ConversationCapabilities> = {},
): ConversationProviderAdapter {
  return {
    id: 'mock-provider',
    displayName: 'Mock provider',
    capabilities: { ...MOCK_CONVERSATION_CAPABILITIES, ...capabilities },
    listModels: () => ['mock-model'],
    startSession(input) {
      return [event(input, 'session_started'), event(input, 'session_ready')]
    },
    sendTurn(input) {
      if (input.message === '/tools') {
        return [
          event(input, 'turn_started', { turnId: input.turnId }),
          ...[
            'Bash',
            'Edit',
            'Read',
            'Write',
            'Grep',
            'Glob',
            'WebFetch',
            'mcp__demo__call',
            'Agent',
            'TodoWrite',
            'CustomTool',
          ].flatMap((name, index) => {
            const toolUseId = `${input.turnId}_tool_${index}`
            return [
              event(input, 'tool_started', {
                turnId: input.turnId,
                toolUseId,
                toolCallId: toolUseId,
                name,
                tool: name,
                kind: inferConversationToolKind(name),
                input: { path: 'example.txt', oldText: 'before', newText: 'after' },
                summary: name,
              }),
              event(input, 'tool_output', {
                turnId: input.turnId,
                toolUseId,
                toolCallId: toolUseId,
                output: 'done',
                isError: false,
                status: 'ok',
              }),
            ]
          }),
          event(input, 'turn_completed', { turnId: input.turnId }),
        ]
      }
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
  payload?: Record<string, unknown>,
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
