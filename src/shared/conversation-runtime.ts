export type ConversationSessionStatus = 'starting' | 'ready' | 'active' | 'awaiting_approval' | 'stopped' | 'failed'

export type ConversationEventType =
  | 'session_started'
  | 'session_ready'
  | 'session_closed'
  | 'turn_started'
  | 'content_delta'
  | 'reasoning_delta'
  | 'tool_started'
  | 'tool_output'
  | 'approval_requested'
  | 'approval_resolved'
  | 'usage_updated'
  | 'turn_completed'
  | 'turn_failed'

export type ConversationEvent = {
  id: string
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  type: ConversationEventType
  createdAt: number
  payload?: Record<string, unknown>
}

export type ConversationSessionSummary = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  status: ConversationSessionStatus
  createdAt: number
  updatedAt: number
}

export type ConversationStartSessionInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
}

export type ConversationSendTurnInput = {
  sessionId: string
  message: string
}

export type ConversationInterruptInput = {
  sessionId: string
}

export type ConversationRespondToRequestInput = {
  sessionId: string
  requestId: string
  approved: boolean
}

export type ConversationStopSessionInput = {
  sessionId: string
}

export type ConversationListSessionsInput = {
  workspaceId?: string
  agentId?: string
}

export type ConversationStartSessionResult =
  | { ok: true; session: ConversationSessionSummary }
  | { ok: false; message: string; event?: ConversationEvent }

export type ConversationSessionActionResult =
  | { ok: true; session: ConversationSessionSummary }
  | { ok: false; message: string; event?: ConversationEvent }

export type ConversationListSessionsResult =
  | { ok: true; sessions: ConversationSessionSummary[] }
  | { ok: false; message: string }

export type ConversationProviderTestInput = {
  providerId: string
  modelId?: string
}

export type ConversationProviderTestState =
  | 'missing_key'
  | 'invalid_key'
  | 'invalid_endpoint'
  | 'reachable'
  | 'network_error'
  | 'rate_limited'
  | 'model_error'
  | 'malformed_response'

export type ConversationProviderTestStatus = {
  providerId: string
  state: ConversationProviderTestState
  message: string
  modelId?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
}

export type ConversationProviderTestResult =
  | { ok: true; status: ConversationProviderTestStatus & { state: 'reachable' } }
  | { ok: false; status: ConversationProviderTestStatus }
