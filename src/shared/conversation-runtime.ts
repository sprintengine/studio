import type {
  ConversationJsonValue,
  ConversationToolKind,
  ConversationToolStatus,
} from '../../packages/conversation-protocol/src/tool-types'
export type {
  ConversationJsonValue,
  ConversationToolKind,
  ConversationToolStatus,
} from '../../packages/conversation-protocol/src/tool-types'

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
  // Absent only on legacy events and provider events before runtime stamping.
  seq?: number
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
  displayName?: string
  capabilities?: ConversationCapabilities
  phase?: import('./conversation/phase').ConversationPhase
  currentToolTitle?: string
  firstUserText?: string
  lastUserText?: string
  lastAssistantText?: string
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
  { command?: string; hostId?: import('./execution-host').ExecutionHostId; models?: string[] } | undefined
>

// Mirrors the terminal-side `cliPermissionPreset` vocabulary
// (CliPermissionPreset) without importing electron-api types. The
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
  // long-running authoring sessions) run file writes without stalling while interactive tools
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

export type ConversationTranscriptResult = { ok: true; events: ConversationEvent[] } | { ok: false; message: string }

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
  mentions?: import('./conversation/mentions').ConversationMentionRef[]
  reasoningEffort?: string
  mode?: 'default' | 'plan' | 'ask'
  commandId?: string
  skills?: ConversationSkillRef[]
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
  commandId?: string
  sessionId: string
}

export type ConversationRespondToRequestInput = {
  commandId?: string
  decision?: import('./conversation/approvalRules').ConversationApprovalDecision
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
  toolUseId?: string
  kind?: ConversationToolKind
  name?: string
  input?: ConversationJsonValue
  inputTruncated?: boolean
  turnId?: string
  toolCallId?: string
  tool: string
  summary?: string
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
  partial?: boolean
  clipped?: boolean
  toolUseId?: string
  preview?: string
  totalBytes?: number
  truncated?: boolean
  status?: ConversationToolStatus
  exitCode?: number
  mime?: string
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

type ConversationQuestionOption = {
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
  commandId?: string
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
  { ok: true; session: ConversationSessionSummary } | { ok: false; message: string; event?: ConversationEvent }

export type ConversationSessionActionResult =
  // `notice` is a plain sentence for the user about a change that was accepted
  // but does not apply yet (switching to Bypass while a turn is still
  // streaming). The action succeeded; this is not an error.
  | { ok: true; session: ConversationSessionSummary; notice?: string }
  | { ok: false; message: string; event?: ConversationEvent }

export type ConversationListSessionsResult =
  { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message: string }

export type ConversationToolDetail = {
  input: ConversationJsonValue
  output: ConversationJsonValue
  status: ConversationToolStatus
  exitCode?: number
  mime?: string
  totalBytes?: number
  clipped: boolean
}
export type ConversationToolDetailInput = ConversationTranscriptInput & { toolUseId: string }
export type ConversationToolEvent =
  | (Omit<ConversationEvent, 'type' | 'payload'> & {
      type: 'tool_started'
      payload: ConversationToolStartedPayload & {
        toolUseId: string
        kind: ConversationToolKind
        name: string
        input: ConversationJsonValue
      }
    })
  | (Omit<ConversationEvent, 'type' | 'payload'> & {
      type: 'tool_output'
      payload: ConversationToolOutputPayload & {
        toolUseId: string
        preview: string
        totalBytes: number
        truncated: boolean
        status: ConversationToolStatus
      }
    })
export type ConversationToolDetailResult =
  | { ok: true; detail: ConversationToolDetail }
  | { ok: false; code: 'not_found' | 'invalid_input' | 'unavailable'; message: string }
export type ConversationCapabilities = {
  permissionPresets?: ConversationPermissionPreset[]
  tools: boolean
  approvals: boolean
  questions: boolean
  planMode: boolean
  images: boolean
  skills: 'native' | 'context' | 'none'
  reasoningEfforts: string[] | null
  interrupt: boolean
  resume: boolean
  subagents: boolean
  cost: boolean
  contextMeter: boolean
  liveModelSwitch: boolean
  checkpoints?: boolean
}
export type ConversationCheckpointFile = {
  path: string
  status: 'added' | 'modified' | 'deleted'
  addedLines: number
  removedLines: number
  binary: boolean
}
export type ConversationCheckpointDiff = { files: ConversationCheckpointFile[]; submodulesExcluded: true }
export type ConversationTurnDiffInput = { key: ConversationKey; turnSeq: number; path?: string }
export type ConversationTurnDiffResult =
  | { ok: true; diff: ConversationCheckpointDiff; patch?: string; original?: string; modified?: string }
  | { ok: false; message: string }
export type ConversationRevertInput = { key: ConversationKey; turnSeq: number; confirmed?: boolean; undo?: boolean }
export type ConversationRevertResult =
  | { ok: true; files: ConversationCheckpointFile[]; reverted: boolean; undoRef?: string }
  | { ok: false; message: string }
export type ConversationSkillRef = { id: string; sourcePath?: string }
export type ConversationApprovalRulesResult =
  | { ok: true; rules: import('./conversation/approvalRules').ConversationApprovalRule[] }
  | { ok: false; message: string }
export type ConversationApprovalRuleRevokeResult = { ok: true } | { ok: false; message: string }

export type ConversationKey = ConversationTranscriptInput
export type ConversationSubscribeInput = { key: ConversationKey; afterSeq?: number; turnLimit?: number }
export type ConversationPage = { events: ConversationEvent[]; hasMore: boolean; beforeCursor: number | null }
export type ConversationLoadEarlierInput = { key: ConversationKey; beforeCursor: number; turnLimit?: number }
export type ConversationPageResult = { ok: true; page: ConversationPage } | { ok: false; message: string }
export type ConversationSessionFrame =
  | { type: 'event'; event: ConversationEvent }
  | { type: 'snapshot'; page: ConversationPage }
  | { type: 'synchronized'; seq: number }
  | { type: 'error'; message: string }
