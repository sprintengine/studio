export type ConversationSessionStatus = 'starting' | 'ready' | 'active' | 'awaiting_approval' | 'stopped' | 'failed'

export type ConversationEventType =
  | 'session_started'
  | 'session_ready'
  | 'session_closed'
  // Stateful providers report their own durable session identity (the resume
  // cursor) through this event; the runtime reads it back from the JSONL
  // transcript on the next startSession to resume natively.
  | 'session_updated'
  // Emitted by the runtime itself at turn start with the user's message text,
  // so the persisted transcript replays complete conversations (user bubbles
  // included) after an app restart.
  | 'user_message'
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
  // The preset currently in force, when the session carries one. Absent means
  // the session never set one and the provider's own default ('default', ask
  // per tool) applies. Changing it mid-conversation goes through
  // `conversation:sessions:set-permission`.
  permissionPreset?: ConversationPermissionPreset
}

// Loose mirror of the CLI runtime override map (`appSettings.cliRuntimes`)
// so stateful CLI-backed providers can honor a custom binary path. Kept
// structural (not the electron-api types) to avoid a shared-type cycle.
export type ConversationCliRuntimeOverrides = Record<
  string,
  { command?: string; useWsl?: boolean; models?: string[] } | undefined
>

// Mirrors the terminal-side `cliPermissionPreset` vocabulary
// (SprintEngineCliPermissionPreset) without importing electron-api types. The
// value tuple is exported so the IPC boundary validates against one list.
export const CONVERSATION_PERMISSION_PRESETS = ['none', 'manual', 'auto', 'bypass'] as const

export type ConversationPermissionPreset = (typeof CONVERSATION_PERMISSION_PRESETS)[number]

export type ConversationStartSessionInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
  // How tool permissions behave for CLI-backed stateful providers: 'none'
  // passes no flag and lets the CLI's own default win, 'manual' asks per tool
  // (approval cards), 'auto' runs with the CLI's supervised-autonomy mode,
  // 'bypass' skips permission checks entirely (explicit opt-in surfaces only,
  // e.g. wizard designer sessions).
  permissionPreset?: ConversationPermissionPreset
  // Tools auto-allowed without an approval card. Lets unattended flows (the
  // Design Wizard) run file writes without stalling while interactive tools
  // (AskUserQuestion) still surface as cards — unlike bypass, which would
  // silence them entirely.
  allowedTools?: string[]
}

export type ConversationProvidersListInput = {
  cliRuntimes?: ConversationCliRuntimeOverrides
}

export type ConversationTranscriptInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
}

export type ConversationTranscriptResult =
  | { ok: true; events: ConversationEvent[] }
  | { ok: false; message: string }

// An image the user attached to a turn, carried live to a vision-capable
// provider as a base64 content block. `dataBase64` is the raw base64 payload
// (no data: URI prefix); `mediaType` is the image MIME type. v1 is live-only:
// attachments reach the provider on the turn they are sent but are not
// persisted to or replayed from the JSONL transcript.
export type ConversationImageAttachment = {
  id: string
  mediaType: string
  dataBase64: string
  name?: string
  byteLength: number
}

export type ConversationSendTurnInput = {
  sessionId: string
  message: string
  // Renderer-generated id of the optimistic user bubble for this send; echoed
  // back on the persisted `user_message` event so the projection can replace
  // the optimistic entry with the authoritative one deterministically.
  localTurnId?: string
  // Images attached to this turn. Live-only in v1 and honored only by
  // vision-capable providers (currently the claude-agent provider); other
  // providers ignore them, so no image block is ever sent to them.
  attachments?: ConversationImageAttachment[]
}

export type ConversationInterruptInput = {
  sessionId: string
}

export type ConversationRespondToRequestInput = {
  sessionId: string
  requestId: string
  approved: boolean
  // Structured answers for question-kind requests (AskUserQuestion): question
  // text → chosen answer (multi-select answers comma-separated, free-text
  // "other" answers verbatim). Ignored for plain tool approvals.
  answers?: Record<string, string>
}

// Payload carried on `tool_started`. `parentToolUseId` is what makes subagent
// work visible: a provider that runs tools inside a spawned agent stamps the
// child calls with the id of the tool call that spawned them, so consumers can
// group them under that parent instead of flattening them into the turn (or,
// as before, dropping them). Absent means an ordinary top-level tool call.
export type ConversationToolStartedPayload = {
  turnId?: string
  toolCallId?: string
  tool: string
  summary: string
  addedLines?: number
  removedLines?: number
  parentToolUseId?: string
  // Set on the tool call that spawns a subagent (Task/Agent). It is the header
  // of a lane whose rows are the tool calls carrying its `toolCallId` as their
  // `parentToolUseId`; its own `tool_output` closes the lane, so the lane's
  // elapsed time is the span between the two events.
  subagentLane?: boolean
  // The kind of subagent the model asked for ('Explore', 'general-purpose', a
  // custom agent id), when the call names one. Lane label; absent means the
  // consumer falls back to `summary`.
  subagentType?: string
}

// Payload carried on `tool_output`. `parentToolUseId` mirrors `tool_started`
// so a child call's completion lands in the same lane as its start.
export type ConversationToolOutputPayload = {
  turnId?: string
  toolCallId?: string
  output: string
  isError: boolean
  parentToolUseId?: string
}

// Structured payload shapes carried on `approval_requested` events. `kind`
// distinguishes a plain tool permission from an interactive question card or
// a plan-approval card; provider-neutral so any stateful adapter can emit
// them and the chat UI renders them the same way.
export type ConversationApprovalKind = 'tool' | 'question' | 'plan'

export type ConversationQuestionOption = {
  label: string
  description?: string
}

export type ConversationQuestion = {
  question: string
  header?: string
  multiSelect?: boolean
  allowFreeText?: boolean
  options: ConversationQuestionOption[]
}

// Change how tool permissions behave on a session that is already running. The
// interactive path only: the change reaches the live provider session and takes
// effect on its next tool call, without recreating the session or losing
// history. The automation MCP surface still refuses `bypass` outright.
export type ConversationSetPermissionInput = {
  sessionId: string
  permissionPreset: ConversationPermissionPreset
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
  // `notice` is a plain sentence for the user about a change that was accepted
  // but does not apply yet (switching to Bypass while a turn is still
  // streaming). The action succeeded; this is not an error.
  | { ok: true; session: ConversationSessionSummary; notice?: string }
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
