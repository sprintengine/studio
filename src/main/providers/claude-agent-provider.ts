// Stateful conversation provider backed by the Claude Agent SDK.
//
// Spawns the user's own installed Claude Code CLI headlessly (subscription
// auth — whatever `claude auth login` already holds; no API key touches this
// path) and maps the SDK's message stream onto Multicode's canonical
// ConversationEvents. One long-lived child process per session, kept across
// turns via the SDK's streaming-input mode; the CLI session id is surfaced as
// `session_updated` events so the runtime can resume natively after the
// process (or the whole app) goes away.
//
// All Claude Agent SDK types are confined to this file on purpose — the SDK
// moves fast, so version churn must not leak past this adapter. The package
// is ESM-only and the main bundle is CJS, so the SDK is loaded via dynamic
// import on first use.
import { spawn } from 'child_process'
import { asRecord } from '../../shared/records'

import type {
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'

import type {
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationImageAttachment,
  ConversationPermissionPreset,
  ConversationQuestion,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
} from '../../shared/conversation-runtime'
import type {
  ConversationProviderAdapter,
  ConversationProviderLiveSession,
  ConversationProviderPermissionResult,
  ConversationSessionEventSink,
  MockAdapterApprovalInput,
  MockAdapterPermissionInput,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './mock-conversation-provider'

export const CLAUDE_AGENT_PROVIDER_ID = 'claude-agent'
// The CLI accepts these on --model regardless of account tier; they track the
// CLI's own vocabulary rather than a remote catalog. Tier aliases float to
// whatever that tier currently resolves to; a full model id pins one release.
// Keep in sync with resources/plugins/claude-agent/plugin.json `models`.
const CLAUDE_AGENT_MODELS = ['claude-opus-5', 'sonnet', 'opus', 'haiku'] as const

// Env marker so process-tree diagnostics can attribute the headless child to
// its conversation session (the SDK exposes no child PID).
export const CLAUDE_AGENT_SESSION_ENV_KEY = 'SPRINTENGINE_CONVERSATION_SESSION_ID'

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query

export type ClaudeAgentProviderOptions = {
  // Injectable seams for tests; defaults wire the real SDK + CLI detection.
  loadQuery?: () => Promise<SdkQueryFunction>
  resolveExecutable?: (cliRuntimes?: ConversationCliRuntimeOverrides) => Promise<string>
  buildEnv?: (input: {
    workspaceId: string
    agentId: string
    sessionId: string
  }) => Record<string, string> | Promise<Record<string, string>>
  now?: () => number
}

export type ClaudeAgentProviderAdapter = ConversationProviderAdapter & {
  listLiveSessions(): ConversationProviderLiveSession[]
  disposeChildProcess(sessionId: string): boolean
  disposeAll(): void
  setPermissionPreset(input: MockAdapterPermissionInput): Promise<ConversationProviderPermissionResult>
}

type PermissionDecision = {
  approved: boolean
  answers?: Record<string, string>
}

type PendingPermissionResolve = (decision: PermissionDecision) => void

// A permission callback the child is blocked on, tagged with the turn whose
// card carries it — ending that turn must resolve it, or the child waits
// forever on a card nobody can answer.
type PendingPermission = {
  turnId: string
  resolve: PendingPermissionResolve
}

type ActiveTurn = {
  turnId: string
  requestId: string
  approvalSequence: number
  queue: PushStream<ConversationEvent>
}

type SessionState = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  workspaceRoot: string
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset: ConversationPermissionPreset
  allowedTools?: string[]
  providerSessionId: string | null
  query: Query | null
  inputQueue: PushStream<SDKUserMessage> | null
  abort: AbortController | null
  childPid: number | null
  spawnedAt: number | null
  turn: ActiveTurn | null
  // Claude Code can hold several permission callbacks open at once (parallel
  // tool_use blocks), so pending permissions are keyed by requestId.
  pendingPermissions: Map<string, PendingPermission>
  // Whether the live child was spawned with the bypass opt-in. Claude Code
  // refuses `bypassPermissions` over the control channel on a child that was
  // not, so switching to it is a respawn, not a mode change.
  queryAllowsBypass: boolean
  // Session-level events (resume cursor updates) that arrived while no turn
  // stream was open to carry them; flushed at the next turn start.
  pendingSessionEvents: ConversationEvent[]
  // Session-scoped continuation channel (set at startSession). When the child
  // resumes after a `result` with no open `sendTurn`, post-`result` events —
  // and any approval they raise — flow to the runtime over this sink via a
  // lazily opened continuation turn instead of being dropped/denied.
  onSessionEvent: ConversationSessionEventSink | null
  // Monotonic counter for continuation-turn ids, unique within the session.
  continuationSequence: number
  lastActivityAt: number
  stderrTail: string
}

// Event types that belong to a turn (carry a turnId and must be suppressed by
// the runtime when they do not match the active turn). Everything else is
// session-scoped and needs no turn to be delivered.
const SESSION_SCOPED_EVENT_TYPES = new Set<ConversationEvent['type']>([
  'session_started',
  'session_ready',
  'session_closed',
  'session_updated',
  'user_message',
])

// Minimal push-based async iterable: producers push/end, one consumer drains.
class PushStream<T> implements AsyncIterable<T> {
  private readonly queue: T[] = []
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value, done: false })
    else this.queue.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.queue.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}

export function createClaudeAgentProvider(options: ClaudeAgentProviderOptions = {}): ClaudeAgentProviderAdapter {
  const loadQuery = options.loadQuery ?? defaultLoadQuery
  const resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable
  const buildEnv = options.buildEnv ?? defaultBuildEnv
  const now = options.now ?? Date.now
  const sessions = new Map<string, SessionState>()

  function deliver(state: SessionState, events: ConversationEvent[]): void {
    for (const event of events) {
      // Post-`result` turn-scoped activity with no open `sendTurn`: open a
      // continuation turn so the event (and any approval it raises) reaches the
      // runtime instead of being dropped. Requires the session channel.
      if (!state.turn && state.onSessionEvent && !SESSION_SCOPED_EVENT_TYPES.has(event.type)) {
        ensureContinuationTurn(state)
      }
      if (state.turn) {
        // Events mapped before the continuation turn existed carry no turnId;
        // stamp the continuation id so the runtime attaches them to its mirror.
        state.turn.queue.push(withContinuationTurnId(event, state.turn.turnId))
      } else if (event.type === 'session_updated') {
        // A resume-cursor update between turns: ride the session channel if it
        // is open, else buffer for the next turn start.
        if (state.onSessionEvent) state.onSessionEvent(event)
        else state.pendingSessionEvents.push(event)
      }
      // Non-session events with no open turn and no channel have nowhere to go
      // (the turn they belonged to was interrupted); drop them.
    }
  }

  // Lazily open a continuation turn for post-`result` activity. Reuses the
  // per-turn machinery (queue, approval sequencing) so handleCanUseTool and
  // deliver are unchanged; a background drain forwards the queue to the session
  // channel. Returns null when no session channel is available.
  function ensureContinuationTurn(state: SessionState): ActiveTurn | null {
    if (state.turn) return state.turn
    if (!state.onSessionEvent) return null
    state.continuationSequence += 1
    const turnId = `${state.sessionId}_cont_${state.continuationSequence}`
    const turn: ActiveTurn = {
      turnId,
      requestId: `approval_${turnId}`,
      approvalSequence: 0,
      queue: new PushStream<ConversationEvent>(),
    }
    state.turn = turn
    state.lastActivityAt = now()
    // Announce the turn first so the runtime opens its mirror before any
    // content or approval events arrive over the channel.
    turn.queue.push(eventFor(state, 'turn_started', { turnId }))
    void drainContinuationTurn(state, turn)
    return turn
  }

  async function drainContinuationTurn(state: SessionState, turn: ActiveTurn): Promise<void> {
    try {
      for await (const event of turn.queue) state.onSessionEvent?.(event)
    } finally {
      if (state.turn === turn) state.turn = null
      // A permission still open when the continuation ends must not leave the
      // child blocked forever — including when the turn ended because a send
      // took the session over.
      resolvePendingPermissionsForTurn(state, turn.turnId, { approved: false })
      state.lastActivityAt = now()
    }
  }

  function endTurn(state: SessionState): void {
    state.turn?.queue.end()
    state.lastActivityAt = now()
  }

  function resolveAllPendingPermissions(state: SessionState, decision: PermissionDecision): void {
    const pending = Array.from(state.pendingPermissions.values())
    state.pendingPermissions.clear()
    for (const { resolve } of pending) resolve(decision)
  }

  function resolvePendingPermissionsForTurn(state: SessionState, turnId: string, decision: PermissionDecision): void {
    for (const [requestId, pending] of Array.from(state.pendingPermissions)) {
      if (pending.turnId !== turnId) continue
      state.pendingPermissions.delete(requestId)
      pending.resolve(decision)
    }
  }

  function disposeChild(state: SessionState): boolean {
    const hadChild = state.query !== null
    resolveAllPendingPermissions(state, { approved: false })
    endTurn(state)
    state.turn = null
    state.inputQueue?.end()
    state.inputQueue = null
    state.abort?.abort()
    state.abort = null
    state.query = null
    state.queryAllowsBypass = false
    state.childPid = null
    state.spawnedAt = null
    return hadChild
  }

  // Whether the live child can honor the session's recorded preset. Only bypass
  // is gated: Claude Code takes it solely from the flag it was spawned with, so
  // a child spawned Default or Auto can never be talked into it.
  function childHonorsPreset(state: SessionState): boolean {
    return state.permissionPreset !== 'bypass' || state.queryAllowsBypass
  }

  async function pump(state: SessionState, q: Query): Promise<void> {
    try {
      for await (const message of q as AsyncIterable<Record<string, unknown>>) {
        if (state.query !== q) return
        deliver(state, mapSdkMessage(state, message))
        if (message.type === 'result') endTurn(state)
      }
    } catch (error) {
      if (state.query !== q) return
      if (state.turn) {
        deliver(state, [
          eventFor(state, 'turn_failed', {
            turnId: state.turn.turnId,
            reason: 'provider',
            message: describeSpawnFailure(error, state.stderrTail),
          }),
        ])
      }
    } finally {
      if (state.query === q) {
        // Child process ended (crash, auth failure, natural exit): close the
        // turn stream so a pending sendTurn resolves, keep the resume cursor.
        if (state.turn) {
          deliver(state, [
            eventFor(state, 'turn_failed', {
              turnId: state.turn.turnId,
              reason: 'provider',
              message: describeSpawnFailure(null, state.stderrTail),
            }),
          ])
        }
        disposeChild(state)
      }
    }
  }

  async function ensureQuery(state: SessionState): Promise<void> {
    // A preset the live child cannot honor (bypass chosen after it spawned) is
    // reconciled here, so the turn about to start runs under the preset the
    // session actually recorded. The respawn below resumes the same provider
    // session, so the conversation continues rather than restarting.
    if (state.query && !childHonorsPreset(state)) disposeChild(state)
    if (state.query) return
    if (state.cliRuntimes?.['claude-code']?.useWsl) {
      throw new Error('Claude conversation agents are not supported for WSL-configured CLI runtimes yet.')
    }
    const executablePath = await resolveExecutable(state.cliRuntimes)
    const sdkQuery = await loadQuery()
    const env = await buildEnv({
      workspaceId: state.workspaceId,
      agentId: state.agentId,
      sessionId: state.sessionId,
    })
    const inputQueue = new PushStream<SDKUserMessage>()
    const abort = new AbortController()
    const permissionMode = SDK_PERMISSION_MODE_BY_PRESET[state.permissionPreset]
    const queryOptions: Options = {
      cwd: state.workspaceRoot,
      pathToClaudeCodeExecutable: executablePath,
      model: state.modelId,
      includePartialMessages: true,
      permissionMode,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(state.allowedTools?.length ? { allowedTools: state.allowedTools } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      env,
      abortController: abort,
      canUseTool: (toolName, toolInput, callbackOptions) =>
        handleCanUseTool(state, toolName, toolInput, callbackOptions?.signal),
      // Spawn the child ourselves (same command/args the SDK computed) so the
      // PID is known: process-tree diagnostics attribute the headless child to
      // this session, and the SDK exposes no PID of its own.
      spawnClaudeCodeProcess: (spawnInput: SpawnOptions): SpawnedProcess =>
        spawnTrackedChild(state, spawnInput, now),
      ...(state.providerSessionId ? { resume: state.providerSessionId } : {}),
    }
    const q = sdkQuery({ prompt: inputQueue, options: queryOptions })
    state.query = q
    state.queryAllowsBypass = permissionMode === 'bypassPermissions'
    state.inputQueue = inputQueue
    state.abort = abort
    void pump(state, q)
  }

  async function handleCanUseTool(
    state: SessionState,
    toolName: string,
    toolInput: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PermissionResult> {
    // A tool that fires after the turn's `result` (e.g. once a background
    // subagent completes and the model resumes) has no open turn. Open a
    // continuation turn so its approval card reaches the UI instead of being
    // auto-denied; deny only when there is no session channel to carry it.
    const turn = state.turn ?? ensureContinuationTurn(state)
    if (!turn) return { behavior: 'deny', message: 'Conversation turn is not active.' }
    turn.approvalSequence += 1
    const requestId = turn.approvalSequence === 1 ? turn.requestId : `${turn.requestId}_${turn.approvalSequence}`

    // Interactive tools become structured cards instead of plain allow/deny:
    // AskUserQuestion renders its options as buttons, ExitPlanMode shows the
    // plan for approval. Everything else is a generic tool-permission card.
    const questions = toolName === 'AskUserQuestion' ? parseAskUserQuestions(toolInput) : null
    const plan = toolName === 'ExitPlanMode' ? readPlanText(toolInput) : null
    const requestPayload: Record<string, unknown> = {
      turnId: turn.turnId,
      requestId,
      action: toolName,
      summary: questions
        ? questions[0]?.question ?? 'The agent has a question.'
        : plan !== null
          ? 'The agent proposed a plan.'
          : summarizeToolInput(toolName, toolInput),
      kind: questions ? 'question' : plan !== null ? 'plan' : 'tool',
      ...(questions ? { questions } : {}),
      ...(plan !== null ? { plan } : {}),
    }
    turn.queue.push(eventFor(state, 'approval_requested', requestPayload))

    const decision = await new Promise<PermissionDecision>((resolve) => {
      state.pendingPermissions.set(requestId, { turnId: turn.turnId, resolve })
      signal?.addEventListener(
        'abort',
        () => {
          if (state.pendingPermissions.delete(requestId)) resolve({ approved: false })
        },
        { once: true }
      )
    })
    state.pendingPermissions.delete(requestId)
    turn.queue.push(
      eventFor(state, 'approval_resolved', {
        turnId: turn.turnId,
        requestId,
        approved: decision.approved,
        ...(decision.answers ? { answers: decision.answers } : {}),
      })
    )
    if (!decision.approved) {
      return {
        behavior: 'deny',
        message: questions
          ? 'The user dismissed the question without answering.'
          : plan !== null
            ? 'The user rejected this plan. Revise it and keep planning.'
            : 'The user denied this tool use in Multicode.',
      }
    }
    if (questions) {
      // AskUserQuestion completes headlessly when the answers ride the input:
      // the CLI-side tool returns them to the model without prompting.
      return { behavior: 'allow', updatedInput: { ...toolInput, answers: decision.answers ?? {} } }
    }
    return { behavior: 'allow', updatedInput: toolInput }
  }

  const adapter: ClaudeAgentProviderAdapter = {
    id: CLAUDE_AGENT_PROVIDER_ID,
    sessions: 'stateful',
    listModels: () => [...CLAUDE_AGENT_MODELS],

    startSession(input: MockAdapterSessionInput) {
      const state: SessionState = {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        workspaceRoot: input.workspaceRoot ?? '',
        cliRuntimes: input.cliRuntimes,
        permissionPreset: input.permissionPreset ?? 'manual',
        allowedTools: input.allowedTools,
        providerSessionId: input.resumeSessionId?.trim() || null,
        query: null,
        inputQueue: null,
        abort: null,
        childPid: null,
        spawnedAt: null,
        turn: null,
        pendingPermissions: new Map(),
        queryAllowsBypass: false,
        pendingSessionEvents: [],
        onSessionEvent: input.onSessionEvent ?? null,
        continuationSequence: 0,
        lastActivityAt: now(),
        stderrTail: '',
      }
      sessions.set(input.sessionId, state)
      return [
        eventFor(state, 'session_started', {
          providerSessionId: state.providerSessionId,
          resumed: state.providerSessionId !== null,
        }),
        eventFor(state, 'session_ready'),
      ]
    },

    async *sendTurn(input: MockAdapterTurnInput): AsyncIterable<ConversationEvent> {
      const state = sessions.get(input.sessionId)
      if (!state) {
        yield turnFailure(input, 'invalid_session', 'Conversation session is not registered with the Claude provider.')
        return
      }
      yield eventFor(state, 'turn_started', { turnId: input.turnId })
      try {
        await ensureQuery(state)
      } catch (error) {
        yield eventFor(state, 'turn_failed', {
          turnId: input.turnId,
          reason: 'spawn',
          message: error instanceof Error ? error.message : 'Claude Code could not be started.',
        })
        return
      }
      const turn: ActiveTurn = {
        turnId: input.turnId,
        requestId: input.requestId,
        approvalSequence: 0,
        queue: new PushStream<ConversationEvent>(),
      }
      // Taking the session's turn over (a continuation opened in the window
      // before the runtime's busy guard could see it): end the queue being
      // replaced first, so its drain stops instead of awaiting an iterator
      // nobody will ever end.
      state.turn?.queue.end()
      state.turn = turn
      state.lastActivityAt = now()
      for (const pendingEvent of state.pendingSessionEvents.splice(0)) turn.queue.push(pendingEvent)

      const onAbort = (): void => {
        void state.query?.interrupt().catch(() => undefined)
        resolveAllPendingPermissions(state, { approved: false })
        turn.queue.end()
      }
      if (input.signal?.aborted) {
        onAbort()
      } else {
        input.signal?.addEventListener('abort', onAbort, { once: true })
      }

      state.inputQueue?.push({
        type: 'user',
        message: { role: 'user', content: buildUserMessageContent(input.message, input.attachments) },
        parent_tool_use_id: null,
        session_id: state.providerSessionId ?? '',
      })

      try {
        for await (const event of turn.queue) yield event
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
        if (state.turn === turn) state.turn = null
        // A permission that never resolved (turn torn down first) must not
        // leave the child blocked forever.
        resolvePendingPermissionsForTurn(state, turn.turnId, { approved: false })
        state.lastActivityAt = now()
      }
    },

    resolveApproval(input: MockAdapterApprovalInput) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      const pending = state.pendingPermissions.get(input.requestId)
      if (!pending) return []
      state.pendingPermissions.delete(input.requestId)
      pending.resolve({ approved: input.approved, answers: input.answers })
      // approval_resolved is emitted through the still-open turn stream so the
      // transcript stays ordered; nothing to return here.
      return []
    },

    // Live permission switch. With a running child the new mode goes down the
    // SDK control channel, so the next tool call honors it; the recorded preset
    // also carries into any later respawn (idle disposal keeps the session).
    // With no child yet the recorded preset is the whole job — ensureQuery reads
    // it at spawn, including the bypass opt-in flag.
    //
    // Bypass is the one mode the control channel cannot deliver: Claude Code
    // takes it from the flag its child was spawned with. So a child spawned
    // Default or Auto is replaced rather than asked — the preset is recorded and
    // the child disposed, and the next turn respawns with `resume`, keeping the
    // conversation. Mid-turn the disposal waits (it would drop the reply the
    // user is reading); ensureQuery makes the swap at the next turn instead.
    async setPermissionPreset(input: MockAdapterPermissionInput): Promise<ConversationProviderPermissionResult> {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Conversation session is not registered with the Claude provider.' }
      if (state.query && input.permissionPreset === 'bypass' && !state.queryAllowsBypass) {
        state.permissionPreset = input.permissionPreset
        state.lastActivityAt = now()
        if (state.turn) {
          return {
            ok: true,
            // Not "the current permissions": the chip has already moved to
            // Bypass by the time this is read, so "current" would name the mode
            // that is NOT in force for the reply on screen. The permissions the
            // reply started under is the one phrase that stays true either way.
            notice:
              'Bypass starts with your next message — this reply finishes under the permissions it started with.',
          }
        }
        disposeChild(state)
        return { ok: true }
      }
      if (state.query) {
        const sdkMode = SDK_PERMISSION_MODE_BY_PRESET[input.permissionPreset]
        // `none` has no SDK mode to set — it means "leave the harness on its own
        // default" — so there is nothing to ask Claude Code to change.
        if (sdkMode === undefined) return { ok: true }
        try {
          await state.query.setPermissionMode(sdkMode)
        } catch (error) {
          // Claude Code owns the decision (it can refuse a mode the session did
          // not opt into at spawn). Surface its refusal instead of recording a
          // preset it is not honoring.
          return {
            ok: false,
            message: error instanceof Error && error.message.trim()
              ? `Claude Code refused the permission change: ${error.message}`
              : 'Claude Code refused the permission change.',
          }
        }
      }
      state.permissionPreset = input.permissionPreset
      state.lastActivityAt = now()
      return { ok: true }
    },

    interrupt(input: MockAdapterSessionInput) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      const turnId = state.turn?.turnId
      void state.query?.interrupt().catch(() => undefined)
      resolveAllPendingPermissions(state, { approved: false })
      endTurn(state)
      state.turn = null
      return [eventFor(state, 'turn_failed', { ...(turnId ? { turnId } : {}), reason: 'interrupted' })]
    },

    stopSession(input: MockAdapterSessionInput) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      disposeChild(state)
      sessions.delete(input.sessionId)
      return [eventFor(state, 'session_closed')]
    },

    listLiveSessions(): ConversationProviderLiveSession[] {
      return Array.from(sessions.values()).map((state) => ({
        sessionId: state.sessionId,
        workspaceId: state.workspaceId,
        agentId: state.agentId,
        workspaceRoot: state.workspaceRoot,
        providerSessionId: state.providerSessionId,
        hasChildProcess: state.query !== null,
        childPid: state.childPid,
        turnActive: state.turn !== null,
        pendingApproval: state.pendingPermissions.size > 0,
        lastActivityAt: state.lastActivityAt,
        spawnedAt: state.spawnedAt,
      }))
    },

    disposeChildProcess(sessionId: string): boolean {
      const state = sessions.get(sessionId)
      if (!state || state.query === null) return false
      return disposeChild(state)
    },

    disposeAll(): void {
      for (const state of sessions.values()) disposeChild(state)
    },
  }

  return adapter
}

// Terminal-preset → SDK permission-mode mapping, mirroring the claude-code
// plugin manifest's permissionPresets flags (`--permission-mode default|auto|
// bypassPermissions`). `none` maps to undefined on purpose: it means "pass no
// permission flag and let the harness's own default win", which for the SDK is
// leaving permissionMode unset rather than pinning it to 'default'.
const SDK_PERMISSION_MODE_BY_PRESET: Record<
  ConversationPermissionPreset,
  'default' | 'auto' | 'bypassPermissions' | undefined
> = {
  none: undefined,
  manual: 'default',
  auto: 'auto',
  bypass: 'bypassPermissions',
}

// Sanitize the CLI tool's AskUserQuestion input into the provider-neutral
// question payload. Returns null when the shape is unrecognized so the call
// degrades to a generic tool approval instead of a broken card.
function parseAskUserQuestions(toolInput: Record<string, unknown>): ConversationQuestion[] | null {
  const rawQuestions = toolInput.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  const questions: ConversationQuestion[] = []
  for (const rawQuestion of rawQuestions) {
    const record = asRecord(rawQuestion)
    if (!record || typeof record.question !== 'string' || !record.question.trim()) return null
    const rawOptions = Array.isArray(record.options) ? record.options : []
    const options = rawOptions
      .map((rawOption) => {
        const option = asRecord(rawOption)
        if (!option || typeof option.label !== 'string' || !option.label.trim()) return null
        return {
          label: option.label,
          ...(typeof option.description === 'string' && option.description.trim()
            ? { description: option.description }
            : {}),
        }
      })
      .filter((option): option is { label: string; description?: string } => option !== null)
    if (options.length === 0) return null
    questions.push({
      question: record.question,
      ...(typeof record.header === 'string' && record.header.trim() ? { header: record.header } : {}),
      multiSelect: record.multiSelect === true,
      // The CLI's own question UI always offers a free-text "Other"; mirror it.
      allowFreeText: true,
      options,
    })
  }
  return questions.length > 0 ? questions : null
}

function readPlanText(toolInput: Record<string, unknown>): string {
  return typeof toolInput.plan === 'string' ? toolInput.plan : ''
}

// Compose the SDK user-message content. Text-only turns keep the plain string
// shape (unchanged path); when images are attached, the content becomes a
// multimodal block array — the text block (when present) followed by one base64
// `image` block per attachment. Media types are already validated at the IPC
// boundary, so they are trusted here.
export function buildUserMessageContent(
  message: string,
  attachments: ConversationImageAttachment[] | undefined
): SDKUserMessage['message']['content'] {
  if (!attachments || attachments.length === 0) return message
  const blocks: Exclude<SDKUserMessage['message']['content'], string> = []
  if (message) blocks.push({ type: 'text', text: message })
  for (const attachment of attachments) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        // The IPC boundary already constrains this to the SDK's image set; the
        // cast is the only widening TS cannot see through.
        media_type: attachment.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: attachment.dataBase64,
      },
    })
  }
  return blocks
}

// Stamp a continuation turn id onto a turn-scoped event that was mapped before
// the continuation turn existed (its payload.turnId is absent). Session-scoped
// events and events that already carry a turnId are returned unchanged, so the
// normal per-turn path is a no-op.
function withContinuationTurnId(event: ConversationEvent, turnId: string): ConversationEvent {
  if (SESSION_SCOPED_EVENT_TYPES.has(event.type)) return event
  const current = event.payload?.turnId
  if (typeof current === 'string' && current) return event
  return { ...event, payload: { ...(event.payload ?? {}), turnId } }
}

// Spawn the SDK-computed command ourselves so the child PID lands on the
// session state (the default SDK spawn hides it). Also owns stderr capture:
// the SDK's `stderr` option only applies to its internal spawn path.
function spawnTrackedChild(
  state: SessionState,
  spawnInput: SpawnOptions,
  now: () => number
): SpawnedProcess {
  const child = spawn(spawnInput.command, spawnInput.args, {
    cwd: spawnInput.cwd,
    env: spawnInput.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: spawnInput.signal,
    windowsHide: true,
  })
  state.childPid = child.pid ?? null
  state.spawnedAt = now()
  child.stderr?.on('data', (data: Buffer) => {
    state.stderrTail = `${state.stderrTail}${data.toString()}`.slice(-4000)
  })
  child.once('exit', () => {
    if (state.childPid === child.pid) state.childPid = null
  })
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    get killed() {
      return child.killed
    },
    get exitCode() {
      return child.exitCode
    },
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  }
}

async function defaultLoadQuery(): Promise<SdkQueryFunction> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk.query
}

async function defaultResolveExecutable(cliRuntimes?: ConversationCliRuntimeOverrides): Promise<string> {
  const { detectCli } = await import('../cli-runtime-install')
  const detection = await detectCli('claude-code', cliRuntimes?.['claude-code'])
  if (!detection.installed || !detection.resolvedPath) {
    throw new Error('Claude Code CLI is not installed. Install it (or set a command override in Settings) to use Claude conversation agents.')
  }
  return detection.resolvedPath
}

// Auth env this provider must never pass to the child. The conversation path
// is subscription-auth by contract: the CLI binds its own `claude login`
// credentials only when ANTHROPIC_API_KEY is absent — an inherited key wins
// silently and bills API usage with no visible banner (headless chat shows no
// CLI chrome). AUTH_TOKEN/BASE_URL redirect the CLI to third-party endpoints;
// they belong to the terminal zai/GLM launch path, never to this provider.
export const STRIPPED_ANTHROPIC_AUTH_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const

export function stripAnthropicAuthEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env }
  for (const key of STRIPPED_ANTHROPIC_AUTH_ENV_KEYS) delete next[key]
  return next
}

async function defaultBuildEnv(input: {
  workspaceId: string
  agentId: string
  sessionId: string
}): Promise<Record<string, string>> {
  // Deferred import keeps terminal-launch (and its transitive electron/pty
  // imports) out of unit tests that only exercise the mapping logic. It must
  // be import() — a bare require('../terminal-launch') survives bundling as a
  // runtime lookup relative to out/main/index.js and fails in the built app.
  const { getTerminalEnv, applyAgentIdentityEnv } = await import('../terminal-launch')
  const env = applyAgentIdentityEnv(stripAnthropicAuthEnv(getTerminalEnv()), {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  })
  env[CLAUDE_AGENT_SESSION_ENV_KEY] = input.sessionId
  return env
}

// --- SDKMessage → ConversationEvent mapping (structural on purpose: the SDK
// message union churns across versions; unknown shapes are dropped) ---

export function mapSdkMessage(
  state: {
    sessionId: string
    workspaceId: string
    agentId: string
    providerId: string
    modelId: string
    providerSessionId: string | null
    turn: { turnId: string } | null
  },
  message: Record<string, unknown>
): ConversationEvent[] {
  const turnId = state.turn?.turnId
  const events: ConversationEvent[] = []
  const messageSessionId = typeof message.session_id === 'string' ? message.session_id : null

  // The CLI init message reports which credential source the child actually
  // bound (`none` = the subscription login this provider guarantees). Ride it
  // on `session_updated` so the chat can warn when a session is somehow not
  // metering against the subscription.
  const apiKeySource =
    message.type === 'system' && message.subtype === 'init' && typeof message.apiKeySource === 'string'
      ? message.apiKeySource
      : null

  if (messageSessionId && messageSessionId !== state.providerSessionId) {
    state.providerSessionId = messageSessionId
    events.push(
      eventFor(state, 'session_updated', {
        providerSessionId: messageSessionId,
        ...(apiKeySource ? { apiKeySource } : {}),
      })
    )
  } else if (apiKeySource) {
    events.push(eventFor(state, 'session_updated', { providerSessionId: state.providerSessionId, apiKeySource }))
  }

  switch (message.type) {
    case 'stream_event': {
      // Text and thinking deltas produced inside a subagent stay dropped: they
      // would interleave into the parent assistant's own streaming bubble. A
      // subagent's visible work rides its parent-linked tool events below.
      if (message.parent_tool_use_id) break
      const streamEvent = asRecord(message.event)
      if (streamEvent?.type !== 'content_block_delta') break
      const delta = asRecord(streamEvent.delta)
      if (!delta) break
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        events.push(eventFor(state, 'content_delta', { turnId, text: delta.text }))
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        events.push(eventFor(state, 'reasoning_delta', { turnId, text: delta.thinking }))
      }
      break
    }
    case 'assistant': {
      // A subagent's own tool calls arrive as assistant messages stamped with
      // the id of the Task call that spawned them; they are emitted as ordinary
      // tool events carrying that link, so the lane can nest them.
      const parentToolUseId = readParentToolUseId(message)
      const content = asRecord(message.message)?.content
      if (!Array.isArray(content)) break
      for (const rawBlock of content) {
        const block = asRecord(rawBlock)
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
        const toolInput = asRecord(block.input) ?? {}
        const payload: ConversationToolStartedPayload = {
          turnId,
          toolCallId: typeof block.id === 'string' ? block.id : undefined,
          tool: block.name,
          summary: summarizeToolInput(block.name, toolInput),
          ...(computeEditDiffCounts(block.name, toolInput) ?? {}),
          ...(parentToolUseId ? { parentToolUseId } : {}),
          ...subagentLaneFields(block.name, toolInput),
        }
        events.push(eventFor(state, 'tool_started', payload))
      }
      break
    }
    case 'user': {
      const parentToolUseId = readParentToolUseId(message)
      const content = asRecord(message.message)?.content
      if (!Array.isArray(content)) break
      for (const rawBlock of content) {
        const block = asRecord(rawBlock)
        if (block?.type !== 'tool_result') continue
        const payload: ConversationToolOutputPayload = {
          turnId,
          toolCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          output: truncate(extractResultText(block.content), 4000),
          isError: block.is_error === true,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        }
        events.push(eventFor(state, 'tool_output', payload))
      }
      break
    }
    case 'result': {
      const usage = asRecord(message.usage)
      if (usage) {
        const inputTokens =
          numberOr(usage.input_tokens, 0) + numberOr(usage.cache_creation_input_tokens, 0) + numberOr(usage.cache_read_input_tokens, 0)
        const outputTokens = numberOr(usage.output_tokens, 0)
        events.push(
          eventFor(state, 'usage_updated', {
            turnId,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          })
        )
      }
      const isError = message.is_error === true || message.subtype !== 'success'
      if (isError) {
        const errors = Array.isArray(message.errors) ? message.errors.filter((entry) => typeof entry === 'string') : []
        const resultText = typeof message.result === 'string' ? message.result : ''
        events.push(
          eventFor(state, 'turn_failed', {
            turnId,
            reason: typeof message.subtype === 'string' && message.subtype !== 'success' ? message.subtype : 'provider',
            message: errors.join('; ') || resultText || 'Claude Code reported an error for this turn.',
          })
        )
      } else {
        events.push(eventFor(state, 'turn_completed', { turnId }))
      }
      break
    }
    default:
      break
  }
  return events
}

// The SDK stamps every message produced inside a spawned agent with the id of
// the tool call that spawned it; top-level traffic carries null.
function readParentToolUseId(message: Record<string, unknown>): string | null {
  const parentToolUseId = message.parent_tool_use_id
  return typeof parentToolUseId === 'string' && parentToolUseId ? parentToolUseId : null
}

// Names the CLI exposes for spawning a subagent; installed versions differ, so
// both are recognized and either one is the header of a lane.
const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent'])

function subagentLaneFields(
  tool: string,
  toolInput: Record<string, unknown>
): Pick<ConversationToolStartedPayload, 'subagentLane' | 'subagentType'> {
  if (!SUBAGENT_TOOL_NAMES.has(tool)) return {}
  const subagentType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.trim() : ''
  return { subagentLane: true, ...(subagentType ? { subagentType } : {}) }
}

function eventFor(
  state: { sessionId: string; workspaceId: string; agentId: string; providerId: string; modelId: string },
  type: ConversationEvent['type'],
  payload?: Record<string, unknown>
): ConversationEvent {
  return {
    id: '',
    sessionId: state.sessionId,
    workspaceId: state.workspaceId,
    agentId: state.agentId,
    providerId: state.providerId,
    modelId: state.modelId,
    type,
    createdAt: 0,
    payload,
  }
}

function turnFailure(input: MockAdapterTurnInput, reason: string, message: string): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type: 'turn_failed',
    createdAt: 0,
    payload: { turnId: input.turnId, reason, message },
  }
}

// Line-count deltas for edit-shaped tool calls, shipped on `tool_started` so
// the chat's work timeline can render `+N −N` chips without re-reading files.
// Write reports additions only (the file's previous content is not visible
// here); unknown tools return null and ship no counts.
function computeEditDiffCounts(
  tool: string,
  input: Record<string, unknown>
): { addedLines: number; removedLines?: number } | null {
  if (tool === 'Edit') {
    return { addedLines: countLines(input.new_string), removedLines: countLines(input.old_string) }
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let addedLines = 0
    let removedLines = 0
    for (const rawEdit of input.edits) {
      const edit = asRecord(rawEdit)
      if (!edit) continue
      addedLines += countLines(edit.new_string)
      removedLines += countLines(edit.old_string)
    }
    return { addedLines, removedLines }
  }
  if (tool === 'Write') {
    return { addedLines: countLines(input.content) }
  }
  return null
}

function countLines(value: unknown): number {
  return typeof value === 'string' && value.length > 0 ? value.split('\n').length : 0
}

export function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return `${tool}: ${truncate(value.trim(), 200)}`
  }
  let json = ''
  try {
    json = JSON.stringify(input) ?? ''
  } catch {
    json = ''
  }
  return json && json !== '{}' ? `${tool}: ${truncate(json, 200)}` : tool
}

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((entry) => {
      const block = asRecord(entry)
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function describeSpawnFailure(error: unknown, stderrTail: string): string {
  const base = error instanceof Error && error.message ? error.message : 'Claude Code exited unexpectedly.'
  const tail = stderrTail.trim().split('\n').slice(-3).join('\n').trim()
  return tail ? `${base} (${truncate(tail, 300)})` : base
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
