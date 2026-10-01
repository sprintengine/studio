// The conversation contract — events, their payloads, pages and stream
// frames — is @sprintengine/conversation-protocol's, which every transport
// speaks (the chat view's IPC, the tailnet lane, the module SDK). It is
// re-exported here under the names app code has always imported; what stays
// below is the runtime's own: session inputs, results and summaries.
import type {
  ConversationApprovalKind,
  ConversationEvent,
  ConversationJsonValue,
  ConversationPage,
  ConversationSessionStatus,
  ConversationToolKind,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
  ConversationToolStatus,
} from '../../packages/conversation-protocol/src/public'
export type {
  ConversationApprovalKind,
  ConversationApprovalRequestedPayload,
  ConversationApprovalResolvedPayload,
  ConversationCursor,
  ConversationEvent,
  ConversationEventType,
  ConversationJsonValue,
  ConversationPage,
  ConversationQuestion,
  ConversationQuestionOption,
  ConversationSessionStatus,
  ConversationStreamFrame as ConversationSessionFrame,
  ConversationSubagentMessagePayload,
  ConversationSubagentState,
  ConversationSubagentStatusPayload,
  ConversationToolKind,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
  ConversationToolStatus,
} from '../../packages/conversation-protocol/src/public'

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
  // Background subagents still running. They keep the conversation working
  // after its turn has ended, so the sidebar and tab still show activity.
  backgroundAgents?: number
  // When the most recent turn completed or failed (the event's own time, so it
  // survives a resume). Absent until a turn has ended. The sidebar and the tab
  // count "finished" from this rather than `updatedAt`, which also moves on a
  // model or permission change.
  lastTurnEndedAt?: number
  // When the turn now running began: its message was sent, or the agent
  // carried on by itself. A message steered into a running turn does not move
  // it. Absent between turns, so a "working for" count needs no event stream.
  turnStartedAt?: number
  // When the person last sent the chat a message (the event's own time, so it
  // survives a resume). `updatedAt` also moves on a model or permission
  // change, which is not the person saying anything. Absent until one is sent.
  lastUserMessageAt?: number
  // Settle, Snooze or the idle sweep ended the chat's child process and
  // nothing has started it again; the next message does. The session and its
  // resume cursor stay, so its status still reads `ready`, but it holds no
  // process and is not warm to switch into. Absent while a child may be live.
  resting?: true
  // The main conversation's prompt cache, as its provider's last request left
  // it: when it goes cold and what a cold resume re-caches
  // (shared/prompt-cache.ts). Absent for a provider that reports no cache.
  promptCache?: import('./prompt-cache').PromptCacheReading
  // The preset currently in force, when the session carries one. Absent means
  // the session never set one and the provider passes no permission override,
  // as `none` does. Changing it mid-conversation goes through
  // `conversation:sessions:set-permission`.
  permissionPreset?: ConversationPermissionPreset
  // The CLI's own mode at that preset (Claude Code's Accept edits), when one
  // other than the preset's own is in force (cli-permission-mode.ts). Absent,
  // the preset's own mode.
  permissionMode?: string
}

// Loose mirror of the CLI runtime override map (`appSettings.cliRuntimes`)
// so stateful CLI-backed providers can honor a custom binary path. Kept
// structural (not the electron-api types) to avoid a shared-type cycle.
export type ConversationCliRuntimeOverrides = Record<
  string,
  { command?: string; hostId?: import('./execution-host').ExecutionHostId; models?: string[] } | undefined
>

// Mirrors the terminal-side `cliPermissionPreset` vocabulary
// (CliPermissionPreset, shared/cli-permission-preset.ts, where each mode's
// meaning is written down) without importing electron-api types. The value
// tuple is exported so the IPC boundary validates against one list.
export const CONVERSATION_PERMISSION_PRESETS = ['none', 'manual', 'auto', 'bypass'] as const

export type ConversationPermissionPreset = (typeof CONVERSATION_PERMISSION_PRESETS)[number]

/**
 * An MCP server a chat's session is started with, on top of whatever the
 * person's own CLI configuration loads: a connector automation's server, or
 * the app's own gateway. The fields an installed server (`McpServerConfig`)
 * carries for the CLI; `envVarNames` names variables the CLI hands the server
 * from its own environment (an HTTP server's bearer token is the first).
 */
export type ConversationMcpServer = {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  envVarNames?: string[]
}

export type ConversationStartSessionInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
  // How tool permissions behave for CLI-backed stateful providers: 'bypass'
  // skips the CLI's permission prompts (the default for every agent), 'auto'
  // lets workspace edits through and asks before anything riskier, 'manual'
  // asks before every edit, command and outside call, and 'none' passes no
  // override and lets the CLI's own configuration decide — which can still
  // ask, as approval cards.
  permissionPreset?: ConversationPermissionPreset
  // The CLI's own mode at that preset, read only beside it; one the provider
  // does not run (`capabilities.permissionModes`) starts the preset's own.
  permissionMode?: string
  // Tools auto-allowed without an approval card. Lets unattended flows (the
  // long-running authoring sessions) run file writes without stalling while interactive tools
  // (AskUserQuestion) still surface as cards — unlike bypass, which would
  // silence them entirely.
  allowedTools?: string[]
  // MCP servers this session alone runs with. Main-only: a start that comes
  // over IPC never carries them. A provider that cannot take servers per
  // session refuses a start that names any, rather than running without them.
  mcpServers?: ConversationMcpServer[]
}

export type ConversationProvidersListInput = {
  cliRuntimes?: ConversationCliRuntimeOverrides
}

// Signing a chat's CLI back in after its login lapsed: the line a plain
// terminal on this machine runs, resolved to the executable the provider runs.
export type ConversationProviderSignInInput = {
  providerId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
}

export type ConversationProviderSignInResult =
  | {
      ok: true
      commandLine: string
      cwd: string
      platform: string
      /** The machine the sign-in terminal opens on; absent is this one. */
      hostId?: import('./execution-host').ExecutionHostId
    }
  | { ok: false; message: string }

export type ConversationTranscriptInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
}

export type ConversationTranscriptResult = { ok: true; events: ConversationEvent[] } | { ok: false; message: string }

// An image the user attached to a turn, carried live to a vision-capable
// provider as a base64 content block. `dataBase64` is the raw base64 payload
// (no data: URI prefix); `mediaType` is the image MIME type. The bytes never
// enter the JSONL transcript: main copies them into the app-data attachment
// store and the `user_message` event records a `ConversationStoredImageAttachment`
// for each, which a replayed bubble reads back by reference.
export type ConversationImageAttachment = {
  id: string
  mediaType: string
  dataBase64: string
  name?: string
  byteLength: number
}

// An attached image as the transcript remembers it. `ref` is relative to the
// app-data attachment store (`<conversation>/<file>`), never a filesystem path:
// the only way to its bytes is `conversationAttachment`, which resolves it
// inside that store and nowhere else.
export type ConversationStoredImageAttachment = {
  id: string
  mediaType: string
  name?: string
  byteLength: number
  ref: string
}

export type ConversationAttachmentInput = { ref: string }
export type ConversationAttachmentResult =
  { ok: true; mediaType: string; dataBase64: string } | { ok: false; message: string }

// A plan the agent proposed, as a file the workspace pane can open. `plan` is
// the text the transcript recorded; `planFilePath` is the agent's own copy
// when it keeps one on this machine (Claude Code's plan file). The result is
// that file when it still holds this plan, otherwise a copy in app data.
export type ConversationPlanDocumentInput = ConversationKey & {
  plan: string
  title?: string
  planFilePath?: string
}
export type ConversationPlanDocumentResult = { ok: true; path: string } | { ok: false; message: string }

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
  // Images attached to this turn. Honored only by vision-capable providers
  // (currently the claude-agent provider); other providers ignore them, so no
  // image block is ever sent to them. Main keeps a copy in the attachment store
  // so the replayed bubble can show them; the model sees them on this turn only.
  attachments?: ConversationImageAttachment[]
  // Deliver into the turn that is running instead of waiting for it to end.
  // Honored where the provider declares `capabilities.steer`; the running
  // turn closes where the message lands, and the reply carries on as this
  // one's.
  steer?: boolean
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
  // The kind of request the caller believes it is answering. Given, an answer
  // to a request of another kind is refused rather than read as that kind's:
  // a plan approved by a client that meant to answer a tool permission is not
  // the same decision. Absent, any kind is answered, as before.
  requestKind?: ConversationApprovalKind
}

// Change how tool permissions behave on a session that is already running. The
// interactive path only: the change reaches the live provider session and takes
// effect on its next tool call, without recreating the session or losing
// history.
export type ConversationSetPermissionInput = {
  commandId?: string
  sessionId: string
  permissionPreset: ConversationPermissionPreset
  // The CLI's own mode at that preset; absent, the preset's own.
  permissionMode?: string
}

// Switch a running conversation to another model of the same provider. The
// CLI's own default row is `default`. Applies from the next turn.
export type ConversationSetModelInput = {
  commandId?: string
  sessionId: string
  modelId: string
}

export type ConversationStopSessionInput = {
  sessionId: string
}

// Settle and Snooze: end the session's child process but keep the session, so
// the next message respawns it and resumes the same provider session.
export type ConversationSuspendSessionInput = {
  sessionId: string
}

// Resume in terminal: the chat's CLI session is taken over by a terminal agent
// running the CLI's own resume (`claude --resume <id>`, `codex resume <id>`).
export type ConversationTerminalHandoffInput = {
  sessionId: string
}

export type ConversationTerminalHandoffResult =
  // The terminal agent now carrying the conversation on, in the chat's workspace.
  { ok: true; workspaceId: string; agentId: string } | { ok: false; message: string }

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
  // The CLI's own modes this chat can run beside the presets' own, by the ids
  // its CLI's manifest keys them under (`conversationPermissionModes`).
  permissionModes?: string[]
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
  // The provider reads `@path` in a prompt as a reference to that workspace
  // file and opens it itself, so a mention can be passed as `@path`.
  atMentions?: boolean
  // The provider takes a user message into a turn it is already running
  // (`steer` on a send). Without it, sending now means stopping the turn first.
  steer?: boolean
  // The provider can take the conversation back to before one of its user
  // messages, dropping that message and everything after it from its own
  // context ("Edit from here"). Without it the action is not offered.
  rewind?: boolean
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
/** A confirmed revert names the exact paths the preview showed; any drift refuses with `changed`. */
export type ConversationRevertInput = {
  key: ConversationKey
  turnSeq: number
  confirmed?: boolean
  undo?: boolean
  files?: string[]
}
export type ConversationRevertResult =
  | {
      ok: true
      files: ConversationCheckpointFile[]
      reverted: boolean
      undoRef?: string
      /** Listed as added but left in place: the checkpoint's ignore rules ignore them. */
      kept?: string[]
    }
  | { ok: false; message: string; changed?: true }
/**
 * Take the conversation back to before the user message at `turnSeq`: that
 * message and every turn after it leave the provider's context and the
 * transcript's view. Files are not touched; a caller that wants them back
 * reverts the turn's checkpoint first.
 */
export type ConversationRewindInput = { key: ConversationKey; turnSeq: number }
export type ConversationRewindResult = { ok: true } | { ok: false; message: string }
export type ConversationSkillRef = { id: string; sourcePath?: string }
export type ConversationApprovalRulesResult =
  | { ok: true; rules: import('./conversation/approvalRules').ConversationApprovalRule[] }
  | { ok: false; message: string }
export type ConversationApprovalRuleRevokeResult = { ok: true } | { ok: false; message: string }

export type ConversationKey = ConversationTranscriptInput
// `afterSeq` with the `generation` from an earlier snapshot or synchronized
// frame asks for only the events after that sequence. A cursor the log cannot
// vouch for (another generation, ahead of the log, or too far behind) gets a
// reset snapshot instead, as does a cursor sent without a generation.
export type ConversationSubscribeInput = {
  key: ConversationKey
  afterSeq?: number
  generation?: string
  turnLimit?: number
}
export type ConversationLoadEarlierInput = { key: ConversationKey; beforeCursor: number; turnLimit?: number }
export type ConversationPageResult = { ok: true; page: ConversationPage } | { ok: false; message: string }
