import type {
  ConversationCapabilities,
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationImageAttachment,
  ConversationPermissionPreset,
} from '../../shared/conversation-runtime'

/** How far `disposeChildProcess` goes; see ConversationProviderAdapter. */
export type ConversationDisposeOptions = { force?: boolean }

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
  displayName?: string
  capabilities?: ConversationCapabilities
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
  // Live permission-preset change on a running session. An adapter that owns a
  // provider session with its own permission mode implements this: it pushes the
  // new mode into the live session so the next tool call honors it, and records
  // the preset so a respawn keeps it. Absent means the adapter has no live
  // permission surface, and the runtime refuses the change instead of recording
  // a preset the provider would never honor.
  setPermissionPreset?(input: MockAdapterPermissionInput): Promise<ConversationProviderPermissionResult>
  // Live model switch on a running session, within the provider's own CLI. The
  // adapter records the model so every later turn (and a respawn) runs on it,
  // and pushes it into a live provider session where the provider has a way
  // to. An adapter that implements this declares `capabilities.liveModelSwitch`
  // so the renderer offers the switch; absent, the runtime refuses it.
  setModel?(input: MockAdapterModelInput): Promise<ConversationProviderPermissionResult>
  // Take an idle session back to a point the adapter itself recorded: the
  // `providerCursor` it put on an earlier turn's end, or null for before the
  // first turn. The adapter drops its live child and continues from there on
  // the next turn, so the turns after the point leave the provider's context.
  // An adapter that implements this declares `capabilities.rewind`.
  rewind?(input: MockAdapterRewindInput): Promise<ConversationProviderPermissionResult>
  // Hand a user message to the turn that is running (`turnId`, the id its
  // `sendTurn` was given), which takes it in without a turn of its own: the
  // running turn's stream goes on carrying every event, and ends only once
  // the provider has answered this message too. It never starts new work or
  // respawns anything; a turn that has not reached the provider yet, or has
  // already ended, refuses. An adapter that implements this declares
  // `capabilities.steer`; without it, sending mid-turn means stopping first.
  steer?(input: MockAdapterSteerInput): Promise<ConversationProviderSteerResult>
  // Optional lifecycle surface for adapters holding child processes: inventory
  // for diagnostics/status, idle disposal (keeps the session + resume cursor;
  // the next turn respawns), and dispose-everything for app shutdown, which
  // settles once whatever the children left on disk is gone.
  listLiveSessions?(): ConversationProviderLiveSession[]
  // Without `force` a child still doing work (a running turn, a pending card,
  // a subagent) is kept and false returned, as the idle sweep needs. With it
  // the child ends whatever it is doing, as Settle and Snooze ask.
  disposeChildProcess?(sessionId: string, options?: ConversationDisposeOptions): boolean
  disposeAll?(): void | Promise<void>
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
  // With `resumeSessionId`: resume only up to this point of that provider
  // session, as a fork, because the conversation was rewound to it and no
  // turn has been sent since.
  resumeSessionAt?: string
  fallbackHistory?: ConversationMessage[]
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset?: ConversationPermissionPreset
  allowedTools?: string[]
  // Session-scoped continuation channel (provider → runtime), set on
  // startSession for stateful adapters whose child outlives a single turn. A
  // long-lived agent legitimately keeps working after the SDK `result` that
  // ends a `sendTurn` — most often when a background subagent (the Task tool)
  // completes and the model resumes to issue more tool calls or an
  // AskUserQuestion. Those events have no open `sendTurn` generator to carry
  // them; the adapter pushes them here instead. Contract: the adapter opens a
  // *continuation turn* by emitting `turn_started` with a fresh turnId, streams
  // its events (content, tool calls, `approval_requested`), and closes it with
  // `turn_completed`/`turn_failed`. The runtime mirrors that turn in its
  // session state and broadcasts through its normal event path, so an approval
  // card raised on this channel surfaces and resolves through the unchanged
  // respondToRequest → resolveApproval path. Absent for stateless adapters.
  onSessionEvent?: ConversationSessionEventSink
  onBeforeTool?: (name: string) => Promise<void>
}

// Callback the runtime hands a stateful adapter to deliver continuation-turn
// events outside a `sendTurn` generator. Fire-and-forget: the runtime serializes
// and persists internally, so the adapter never awaits it.
export type ConversationSessionEventSink = (event: ConversationEvent) => void

// `attachments` is structural parity with the turn input; v1 does not persist
// or replay it in history, so the runtime never populates it here.
export type ConversationMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  attachments?: ConversationImageAttachment[]
}

export type MockAdapterTurnInput = MockAdapterSessionInput & {
  reasoningEffort?: string
  mode?: 'default' | 'plan' | 'ask'
  turnId: string
  requestId: string
  message: string
  skills?: string[]
  // Images attached to this turn, on this turn only: later turns' history does
  // not repeat them. Vision-capable adapters compose them into the provider
  // request, others ignore them.
  attachments?: ConversationImageAttachment[]
  // Full chat history including the current user turn, in send order. Providers
  // that support multi-turn context send this; absent for legacy/mock callers,
  // who fall back to the single `message`.
  messages?: ConversationMessage[]
  signal?: AbortSignal
}

// The session context, the running turn, and the message to hand it.
export type MockAdapterSteerInput = MockAdapterSessionInput & {
  turnId: string
  message: string
  attachments?: ConversationImageAttachment[]
}

// Whether the message went in. `providerCursor` is where the provider's own
// session stood as it did: what going back to before this message returns to.
export type ConversationProviderSteerResult =
  { ok: true; providerCursor?: ConversationProviderCursor } | { ok: false; message: string }

// The session context plus the preset to switch to, for `setPermissionPreset`.
export type MockAdapterPermissionInput = MockAdapterSessionInput & {
  permissionPreset: ConversationPermissionPreset
}

// The session context plus the model to switch to, for `setModel`. `modelId`
// here is the NEW model; the CLI's own default row is `default`.
export type MockAdapterModelInput = MockAdapterSessionInput & { nextModelId: string }

// Where a stateful provider's own session stood at the end of a turn: which
// provider session, and the last entry of its history the turn left. Adapters
// that rewind put one on each turn end they emit (`providerCursor` in the
// payload); `at` is null when the adapter could not tell.
export type ConversationProviderCursor = { sessionId: string; at: string | null }

// The session context plus where to take it back to; null is before the
// conversation's first turn.
export type MockAdapterRewindInput = MockAdapterSessionInput & { cursor: ConversationProviderCursor | null }

// Whether the adapter actually applied the preset. A failure message is shown to
// the user, so it must say what the provider refused rather than a generic error.
// `notice` accompanies a preset the adapter recorded but could not apply to the
// turn already running; it is shown as information, never as a failure.
export type ConversationProviderPermissionResult = { ok: true; notice?: string } | { ok: false; message: string }

export type MockAdapterApprovalInput = MockAdapterSessionInput & {
  turnId: string
  requestId: string
  approved: boolean
  // Structured answers for question-kind approvals (question text → answer).
  answers?: Record<string, string>
}
