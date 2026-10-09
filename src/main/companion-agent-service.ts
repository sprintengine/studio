// Companion-agent surface: workspace-bound background agents driven through the
// main-process conversation runtime.
//
// A companion is a long-lived agent that lives with a workspace — it answers
// chat and runs structured JSON tasks, and it surfaces in the Sessions popover
// like any workspace agent because it wraps a real ConversationRuntime session
// (which enters the `getSessionItems` projection keyed on (workspaceId,
// agentId)). This service is the platform extraction of plumbing that used to
// be written per feature, with the Review guide as its first consumer.
//
// Semantics that must hold (each a lesson learned elsewhere):
//   - Conversation-runtime owned. Sessions are created through the runtime; a
//     session that produces no conversation record never enters the projection
//     and is invisible (the wizard bug).
//   - Cold-load contract. `attach` NEVER spawns. It returns a handle in
//     `absent` status; the first `runStructured`/`send` (a live user intent)
//     spawns. This mirrors resolveAgentColdLoadDecision (terminalColdLoad.ts),
//     which returns 'inert' for a persisted record with no live intent.
//   - One writer. A second `attach` with the same (workspaceId, agentId)
//     returns the SAME handle; a second concurrent `runStructured` interrupts
//     the first — never two live runs on one session.
//   - Turn-end truth. `runStructured` resolves on the raw turn-end events
//     (turn_completed / turn_failed), not phase inference.
//   - Status honesty. `status()` folds from the same conversation-session
//     projection the Sessions popover reads; `absent` = not present.
//   - Tools are asked about. A companion session starts on `manual`, so every
//     edit, command, web request and MCP tool raises an approval, and a
//     structured run's `tools` policy decides what happens to it: `none` (the
//     default) denies it and tells the agent up front it has no tools, `ask`
//     leaves it open for the person, `auto` approves it. A module's `auto`
//     needs `conversation:bypass`, because approving every tool call is what
//     that permission discloses (createCompanionAgentsModuleRegistry).

import type { CliPermissionPreset } from '../shared/cli-permission-preset'
import { CONVERSATION_DEFAULT_MODEL_ID, conversationProviderForCli } from '../shared/conversation-harness'
import { ceilingAllowsUnaskedTools } from '../shared/permission-ceiling'
import { moduleToolCallerCeiling } from './module-host/module-tool-caller'
import type {
  ConversationEvent,
  ConversationInterruptInput,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSessionStatus,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
} from '../shared/conversation-runtime'

// The slice of ConversationRuntime the companion service drives. The live app
// passes its shared ConversationRuntime; contract tests pass a ConversationRuntime
// built with an authored ConversationProviderAdapter, so this is the real path,
// not a mock of the runtime.
type CompanionConversationRuntime = {
  startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>
  respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult>
  stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult>
  listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

// The handle's status vocabulary reuses the existing ConversationSessionStatus
// (the Sessions popover reads the same values) plus `absent` — not present in
// the projection, i.e. never spawned or already disposed. There is deliberately
// no new AgentSessionStatus enum.
type CompanionAgentStatus = ConversationSessionStatus | 'absent'

type CompanionAgentSpec = {
  workspaceId: string
  /** Stable, module-chosen id (e.g. 'review-guide'); the projection key. */
  agentId: string
  /** Display name in the Sessions popover. */
  name: string
  /**
   * Absolute workspace folder. The main process has no workspaceId → folder
   * registry (workspaceRoot is caller-supplied everywhere conversation sessions
   * are started), so the caller provides it here, exactly as
   * ConversationStartSessionInput requires.
   */
  workspaceRoot: string
  /**
   * Engine selection; resolves to a provider/model pair (defaults claude-agent/sonnet).
   * `cli` takes a chat runtime id (`claude-code`, `codex`: what `listChatRuntimes()`
   * lists and a conversation's `cli` takes) or a conversation provider id
   * (`claude-agent`, `codex-agent`); both name the same engine.
   */
  engine?: { cli?: string; model?: string }
  /** Advisory context roots. The provider already resolves knowledge from workspaceRoot. */
  contextRoots?: { knowledge?: boolean }
  /** Role instructions, delivered as a preamble on the first turn. */
  systemPrompt: string
}

type CompanionValidateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/**
 * What a structured run does with an approval its agent raises: `none` denies
 * it (and the agent is told up front it has no tools), `ask` leaves it open
 * for the person, `auto` approves it.
 */
type CompanionToolPolicy = 'none' | 'ask' | 'auto'

const COMPANION_TOOL_POLICIES: ReadonlySet<string> = new Set<CompanionToolPolicy>(['none', 'ask', 'auto'])

type CompanionRunStructuredOptions<T> = {
  prompt: string
  validate: (raw: unknown) => CompanionValidateResult<T>
  /** Validator errors are fed back to the agent and the turn retried. Default 1. */
  retries?: number
  onPhase?: (phase: string) => void
  /** What the run does with the agent's tool approvals. Default `none`. */
  tools?: CompanionToolPolicy
}

/** An answer to one open approval request: allow it once, or deny it. */
type CompanionApprovalAnswer = { requestId: string; decision: 'once' | 'deny' }

type CompanionApprovalResult = { ok: true } | { ok: false; message: string }

type Unsubscribe = () => void

type CompanionAgentHandle = {
  readonly workspaceId: string
  readonly agentId: string
  status(): CompanionAgentStatus
  onStatus(cb: (status: CompanionAgentStatus) => void): Unsubscribe
  runStructured<T>(opts: CompanionRunStructuredOptions<T>): Promise<T>
  send(message: string): Promise<void>
  /**
   * Answer an approval the agent raised and nothing has answered: one a
   * structured run with `tools: 'ask'` left open, or one a chat turn raised.
   */
  respondToApproval(input: CompanionApprovalAnswer): Promise<CompanionApprovalResult>
  onEvent(cb: (event: ConversationEvent) => void): Unsubscribe
  interrupt(): void
  dispose(): void
}

export type CompanionAgentService = {
  attach(spec: CompanionAgentSpec): CompanionAgentHandle
  /** Unsubscribe from the runtime event stream. App-level teardown only. */
  dispose(): void
}

// Thrown when a structured run's output fails validation on every allowed
// attempt; carries the last validator errors so callers can surface them.
export class CompanionValidationError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(`Companion structured output failed validation: ${errors.join('; ')}`)
    this.name = 'CompanionValidationError'
    this.errors = errors
  }
}

// Thrown when the underlying turn fails (turn_failed) during a structured run.
class CompanionTurnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompanionTurnError'
  }
}

type StructuredRunCollector = {
  sessionId: string
  text: string
  tools: CompanionToolPolicy
  settle: (result: { ok: true; text: string } | { ok: false; message: string }) => void
  settled: boolean
}

type CompanionEntry = {
  spec: CompanionAgentSpec
  key: string
  sessionId: string | null
  disposed: boolean
  spawning: Promise<void> | null
  // Set while startSession is in flight. The runtime emits the new session's
  // first events before startSession answers with its id, and other sessions
  // of the same (workspaceId, agentId) — a leftover one being retired, say —
  // emit on the same key. Events are held here until the id is known, then
  // only the new session's are delivered.
  pendingStart: { events: ConversationEvent[] } | null
  /** Delivered once, prepended to the first outgoing turn. */
  pendingPreamble: string | null
  lastStatus: CompanionAgentStatus
  statusListeners: Set<(status: CompanionAgentStatus) => void>
  eventListeners: Set<(event: ConversationEvent) => void>
  activeCollector: StructuredRunCollector | null
  // Approval requests the session raised that nothing has answered yet: what
  // `respondToApproval` may answer.
  openApprovals: Set<string>
  // The last turn's sendTurn promise. A run resolves on the turn-end EVENT, but
  // the runtime clears the session's pending-request lock only when sendTurn's
  // promise settles — so a clean sequential turn (a retry, a chat after a run)
  // must await this first. Interrupt clears it: the dangling turn was canceled
  // and force-cleared, so the next turn must not block on it.
  pendingSend: Promise<unknown> | null
  // In-flight runtime interrupt. The handle's interrupt() is fire-and-forget
  // (void by contract), so the next turn must wait for the runtime to finish
  // clearing the session before it sends, or it races the pending-request lock.
  pendingInterrupt: Promise<void> | null
  handle: CompanionAgentHandle
}

export type CreateCompanionAgentServiceOptions = {
  runtime: CompanionConversationRuntime
  /** Maps an engine spec to a provider/model pair. Default: claude-agent / sonnet. */
  resolveEngineDefaults?: (engine?: CompanionAgentSpec['engine']) => { providerId: string; modelId: string }
}

const DEFAULT_PROVIDER_ID = 'claude-agent'
const DEFAULT_MODEL_ID = 'sonnet'
// The preset a companion session runs on: every edit, command, web request and
// MCP tool raises an approval, so the run's tool policy is what decides.
const COMPANION_PERMISSION_PRESET: CliPermissionPreset = 'manual'
// Said before a `tools: 'none'` run's prompt, so the agent does not spend the
// turn on tool calls that are each going to be denied.
const NO_TOOLS_NOTE =
  'You have no tools for this task: do not call any tool, and do not try to read or change files. Answer from what this message gives you.'
// A start answers within a handful of events; the cap only bounds a runtime
// that emits on the key without end while the start hangs.
const MAX_PENDING_START_EVENTS = 256

/**
 * The provider an engine's `cli` names: a chat runtime id (`claude-code`) maps
 * to the provider that drives it as a chat (`claude-agent`), so a module uses
 * one id space for its conversations and its companions; anything else is
 * taken as a provider id already.
 */
export function companionProviderIdFor(cli: string | undefined): string {
  const id = cli?.trim()
  if (!id) return DEFAULT_PROVIDER_ID
  return conversationProviderForCli(id) ?? id
}

function defaultEngineDefaults(engine?: CompanionAgentSpec['engine']): { providerId: string; modelId: string } {
  const providerId = companionProviderIdFor(engine?.cli)
  return {
    providerId,
    // `sonnet` is a Claude alias; another engine runs its own default model.
    modelId:
      engine?.model?.trim() || (providerId === DEFAULT_PROVIDER_ID ? DEFAULT_MODEL_ID : CONVERSATION_DEFAULT_MODEL_ID),
  }
}

function entryKey(workspaceId: string, agentId: string): string {
  // NUL is not valid in either id, so it cannot collide with the ids themselves.
  return `${workspaceId}\0${agentId}`
}

export function createCompanionAgentService(options: CreateCompanionAgentServiceOptions): CompanionAgentService {
  const runtime = options.runtime
  const resolveEngineDefaults = options.resolveEngineDefaults ?? defaultEngineDefaults
  const entries = new Map<string, CompanionEntry>()

  // One subscription to the runtime, fanned out to entries by (workspaceId,
  // agentId). onStatus/onEvent are fed from here — never from output parsing.
  const unsubscribeRuntime = runtime.onEvent((event) => {
    const entry = entries.get(entryKey(event.workspaceId, event.agentId))
    if (!entry || entry.disposed) return
    // No session of its own yet: nothing on this key is the companion's until
    // its start answers. Held while a start is in flight, dropped otherwise.
    if (!entry.sessionId) {
      if (entry.pendingStart && entry.pendingStart.events.length < MAX_PENDING_START_EVENTS) {
        entry.pendingStart.events.push(event)
      }
      return
    }
    if (event.sessionId !== entry.sessionId) return
    deliver(entry, event)
  })

  function deliver(entry: CompanionEntry, event: ConversationEvent): void {
    // Forward canonical (redacted) events to chat UIs.
    if (entry.eventListeners.size > 0) {
      const redacted = redactEvent(event)
      for (const listener of entry.eventListeners) listener(redacted)
    }

    // What is still open to answer: an approval stays open until it resolves
    // or its turn ends, however that happens.
    const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
    if (event.type === 'approval_requested' && requestId && event.payload?.autoApproved !== true) {
      entry.openApprovals.add(requestId)
    } else if (event.type === 'approval_resolved' && requestId) {
      entry.openApprovals.delete(requestId)
    } else if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'session_closed') {
      entry.openApprovals.clear()
    }

    // Drive an in-flight structured run off the raw turn-end events.
    const collector = entry.activeCollector
    if (collector && event.sessionId === collector.sessionId) {
      if (event.type === 'content_delta') {
        const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
        if (text) collector.text += text
      } else if (event.type === 'approval_requested') {
        // The run's policy answers the approval so the turn can reach its end:
        // `auto` allows it, `none` denies it, and `ask` leaves it for the
        // person. Deferred to a microtask so we never re-enter the runtime
        // mid-emit. Chat sends (send()) answer nothing: those are the person's.
        if (requestId && entry.sessionId && collector.tools !== 'ask' && event.payload?.autoApproved !== true) {
          const sessionId = entry.sessionId
          const approved = collector.tools === 'auto'
          queueMicrotask(() => void answerApproval(entry, sessionId, requestId, approved))
        }
      } else if (event.type === 'turn_completed') {
        settleCollector(collector, { ok: true, text: collector.text })
      } else if (event.type === 'turn_failed') {
        const message =
          typeof event.payload?.message === 'string'
            ? event.payload.message
            : typeof event.payload?.reason === 'string'
              ? String(event.payload.reason)
              : 'Companion turn failed.'
        settleCollector(collector, { ok: false, message })
      }
    }

    notifyStatus(entry)
  }

  // One answer to an open approval, through the runtime. A stateless provider
  // takes an answer as a separate continuation stream, and the next turn (a
  // validation retry) must wait for both streams to drain.
  function answerApproval(
    entry: CompanionEntry,
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<ConversationSessionActionResult> {
    entry.openApprovals.delete(requestId)
    const prior = entry.pendingSend
    const response = runtime
      .respondToRequest({ sessionId, requestId, approved })
      .catch((error: unknown): ConversationSessionActionResult => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
    entry.pendingSend = Promise.all([prior, response])
      .then(() => undefined)
      .catch(() => undefined)
    return response
  }

  async function respondToApproval(
    entry: CompanionEntry,
    input: CompanionApprovalAnswer,
  ): Promise<CompanionApprovalResult> {
    if (entry.disposed) return { ok: false, message: 'Companion agent is disposed.' }
    const requestId = typeof input?.requestId === 'string' ? input.requestId : ''
    if (input?.decision !== 'once' && input?.decision !== 'deny') {
      return { ok: false, message: '"decision" must be "once" or "deny".' }
    }
    const sessionId = entry.sessionId
    if (!sessionId || !requestId || !entry.openApprovals.has(requestId)) {
      return { ok: false, message: `No approval request "${requestId}" is waiting on this companion.` }
    }
    const answered = await answerApproval(entry, sessionId, requestId, input.decision === 'once')
    return answered.ok ? { ok: true } : { ok: false, message: answered.message }
  }

  function settleCollector(
    collector: StructuredRunCollector,
    result: { ok: true; text: string } | { ok: false; message: string },
  ): void {
    if (collector.settled) return
    collector.settled = true
    collector.settle(result)
  }

  function currentStatus(entry: CompanionEntry): CompanionAgentStatus {
    if (entry.disposed || !entry.sessionId) return 'absent'
    const listed = runtime.listSessions({ workspaceId: entry.spec.workspaceId, agentId: entry.spec.agentId })
    if (!listed.ok) return 'absent'
    const summary = listed.sessions.find((session) => session.sessionId === entry.sessionId)
    return summary ? summary.status : 'absent'
  }

  function notifyStatus(entry: CompanionEntry): void {
    const next = currentStatus(entry)
    if (next === entry.lastStatus) return
    entry.lastStatus = next
    for (const listener of entry.statusListeners) listener(next)
  }

  // Cold-load contract: attach never spawns. Spawn happens here, on the first
  // live intent (runStructured / send). Concurrent callers share one spawn.
  async function ensureSpawned(entry: CompanionEntry): Promise<void> {
    if (entry.disposed) throw new Error('Companion agent is disposed.')
    if (entry.sessionId) return
    if (entry.spawning) return entry.spawning
    const { providerId, modelId } = resolveEngineDefaults(entry.spec.engine)
    const pendingStart: { events: ConversationEvent[] } = { events: [] }
    entry.pendingStart = pendingStart
    entry.spawning = (async () => {
      try {
        const started = await runtime.startSession({
          workspaceRoot: entry.spec.workspaceRoot,
          workspaceId: entry.spec.workspaceId,
          agentId: entry.spec.agentId,
          providerId,
          modelId,
          permissionPreset: COMPANION_PERMISSION_PRESET,
        })
        if (!started.ok) {
          throw new Error(`Companion session could not start: ${started.message}`)
        }
        const sessionId = started.session.sessionId
        // Disposed while starting: the session it started is nobody's.
        if (entry.disposed) {
          void runtime.stopSession({ sessionId }).catch(() => undefined)
          return
        }
        entry.sessionId = sessionId
        entry.pendingPreamble = entry.spec.systemPrompt.trim() || null
        // What the new session said while it was starting, and nothing any
        // other session on this key said.
        for (const event of pendingStart.events) if (event.sessionId === sessionId) deliver(entry, event)
        notifyStatus(entry)
      } finally {
        if (entry.pendingStart === pendingStart) entry.pendingStart = null
      }
    })()
    try {
      await entry.spawning
    } finally {
      entry.spawning = null
    }
  }

  // Deliver the system-prompt preamble once, prepended to the first outgoing
  // turn. The runtime's startSession carries no system-prompt field, so the
  // agent receives its role instructions this way.
  function consumePreamble(entry: CompanionEntry, message: string): string {
    if (!entry.pendingPreamble) return message
    const preamble = entry.pendingPreamble
    entry.pendingPreamble = null
    return `${preamble}\n\n${message}`
  }

  function interruptEntry(entry: CompanionEntry): Promise<void> {
    if (!entry.sessionId) return Promise.resolve()
    const collector = entry.activeCollector
    if (collector) settleCollector(collector, { ok: false, message: 'interrupted' })
    entry.activeCollector = null
    // The canceled turn's sendTurn is force-cleared by the interrupt below; the
    // next turn must not serialize behind its (possibly still-streaming) drain.
    entry.pendingSend = null
    const pending = runtime
      .interrupt({ sessionId: entry.sessionId })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (entry.pendingInterrupt === pending) entry.pendingInterrupt = null
      })
    entry.pendingInterrupt = pending
    return pending
  }

  // Send one turn and resolve with its full assistant text when the turn ends.
  // Resolution keys off turn_completed / turn_failed (via the collector), so it
  // works for both stateless providers (which end the stream at an approval,
  // then complete via respondToRequest) and stateful providers (mid-turn
  // approvals, single streaming sendTurn).
  async function runTurn(entry: CompanionEntry, message: string, tools: CompanionToolPolicy): Promise<string> {
    // Serialize behind a prior clean turn (whose lock clears only when its
    // sendTurn settles) and any fire-and-forget interrupt still clearing state.
    if (entry.pendingSend) await entry.pendingSend.catch(() => undefined)
    if (entry.pendingInterrupt) await entry.pendingInterrupt
    const sessionId = entry.sessionId
    if (!sessionId) throw new Error('Companion session is not spawned.')
    const done = createDeferred<{ ok: true; text: string } | { ok: false; message: string }>()
    const collector: StructuredRunCollector = {
      sessionId,
      text: '',
      tools,
      settle: done.resolve,
      settled: false,
    }
    entry.activeCollector = collector
    try {
      // Drive the turn but resolve on the turn-end EVENTS (via the collector),
      // not on sendTurn draining — so an interrupt that settles the collector
      // rejects this run promptly even while a slow turn is still streaming. A
      // sendTurn that fails to start settles the collector itself.
      const sendPromise = runtime
        .sendTurn({ sessionId, message })
        .then((sent) => {
          if (!sent.ok) settleCollector(collector, { ok: false, message: sent.message })
          return sent
        })
        .catch((error) => {
          settleCollector(collector, { ok: false, message: error instanceof Error ? error.message : String(error) })
        })
      entry.pendingSend = sendPromise
      const result = await done.promise
      if (!result.ok) throw new CompanionTurnError(result.message)
      return result.text
    } finally {
      if (entry.activeCollector === collector) entry.activeCollector = null
    }
  }

  async function runStructured<T>(entry: CompanionEntry, opts: CompanionRunStructuredOptions<T>): Promise<T> {
    if (entry.disposed) throw new Error('Companion agent is disposed.')
    const tools = opts.tools ?? 'none'
    if (!COMPANION_TOOL_POLICIES.has(tools)) throw new Error('"tools" must be "none", "ask" or "auto".')
    await ensureSpawned(entry)
    // One writer: a second concurrent structured run interrupts the first.
    if (entry.activeCollector) await interruptEntry(entry)

    const maxRetries = Math.max(0, opts.retries ?? 1)
    let message = consumePreamble(entry, tools === 'none' ? `${NO_TOOLS_NOTE}\n\n${opts.prompt}` : opts.prompt)
    let lastErrors: string[] = []
    for (let attempt = 0; ; attempt += 1) {
      opts.onPhase?.(attempt === 0 ? 'running' : 'retrying')
      const text = await runTurn(entry, message, tools)
      opts.onPhase?.('validating')
      const raw = extractJson(text)
      if (raw !== undefined) {
        const result = opts.validate(raw)
        if (result.ok) return result.value
        lastErrors = result.errors.length > 0 ? result.errors : ['Validation failed.']
      } else {
        lastErrors = ['No JSON object was found in the response.']
      }
      if (attempt >= maxRetries) throw new CompanionValidationError(lastErrors)
      message = buildRetryPrompt(lastErrors)
    }
  }

  async function send(entry: CompanionEntry, rawMessage: string): Promise<void> {
    if (entry.disposed) throw new Error('Companion agent is disposed.')
    const message = rawMessage.trim()
    if (!message) throw new Error('Companion chat message is required.')
    await ensureSpawned(entry)
    // Chat is single-flight per session: cancel any in-flight structured run.
    if (entry.activeCollector) await interruptEntry(entry)
    if (entry.pendingSend) await entry.pendingSend.catch(() => undefined)
    if (entry.pendingInterrupt) await entry.pendingInterrupt
    const sessionId = entry.sessionId
    if (!sessionId) throw new Error('Companion session is not spawned.')
    const sendPromise = runtime.sendTurn({ sessionId, message: consumePreamble(entry, message) })
    entry.pendingSend = sendPromise
    const sent = await sendPromise
    if (!sent.ok) throw new Error(`Companion chat turn failed: ${sent.message}`)
  }

  function disposeEntry(entry: CompanionEntry): void {
    if (entry.disposed) return
    entry.disposed = true
    const collector = entry.activeCollector
    if (collector) settleCollector(collector, { ok: false, message: 'disposed' })
    entry.activeCollector = null
    const sessionId = entry.sessionId
    entry.sessionId = null
    entries.delete(entry.key)
    // Best-effort session teardown; the handle is already inert.
    if (sessionId) void runtime.stopSession({ sessionId }).catch(() => undefined)
    const wasAbsent = entry.lastStatus === 'absent'
    entry.lastStatus = 'absent'
    if (!wasAbsent) for (const listener of entry.statusListeners) listener('absent')
    entry.statusListeners.clear()
    entry.eventListeners.clear()
    entry.openApprovals.clear()
  }

  function buildHandle(entry: CompanionEntry): CompanionAgentHandle {
    return {
      workspaceId: entry.spec.workspaceId,
      agentId: entry.spec.agentId,
      status: () => currentStatus(entry),
      onStatus: (cb) => {
        entry.statusListeners.add(cb)
        cb(currentStatus(entry))
        return () => entry.statusListeners.delete(cb)
      },
      runStructured: (opts) => runStructured(entry, opts),
      send: (message) => send(entry, message),
      respondToApproval: (input) => respondToApproval(entry, input),
      onEvent: (cb) => {
        entry.eventListeners.add(cb)
        return () => entry.eventListeners.delete(cb)
      },
      interrupt: () => {
        void interruptEntry(entry)
      },
      dispose: () => disposeEntry(entry),
    }
  }

  return {
    attach(spec: CompanionAgentSpec): CompanionAgentHandle {
      const key = entryKey(spec.workspaceId, spec.agentId)
      const existing = entries.get(key)
      // One writer: same (workspaceId, agentId) returns the same live handle.
      if (existing && !existing.disposed) return existing.handle
      const entry: CompanionEntry = {
        spec,
        key,
        sessionId: null,
        disposed: false,
        spawning: null,
        pendingStart: null,
        pendingPreamble: null,
        lastStatus: 'absent',
        statusListeners: new Set(),
        eventListeners: new Set(),
        activeCollector: null,
        openApprovals: new Set(),
        pendingSend: null,
        pendingInterrupt: null,
        handle: undefined as unknown as CompanionAgentHandle,
      }
      entry.handle = buildHandle(entry)
      entries.set(key, entry)
      return entry.handle
    },
    dispose(): void {
      unsubscribeRuntime()
      for (const entry of Array.from(entries.values())) disposeEntry(entry)
    },
  }
}

// The moduleId-first registry behind the SDK's getCompanionAgentsService helper.
// It enforces the `agents:companion` permission at attach time, then delegates
// to the app's companion service under an agent id namespaced by the module
// (`companionAgentIdFor`): a module picks its companion's id, and without the
// namespace two modules picking the same one — or one picking the id of a chat
// the person already has — would share a conversation.
//
// The handle it gives a module checks the two answers to an agent's tool call
// that let the agent act: a structured run with `tools: 'auto'` approves every
// one, which is as loose as `bypass`, so it needs `conversation:bypass` (and is
// refused while the module serves a capped agent's tool call, as `allowedTools`
// is); and allowing one with `respondToApproval` is relaying the person's
// answer, as a module does for its chats, so it needs `conversation:operate`.
// Without either, a module's companion acts only by what it says. Read per
// call, never cached, like every other permission check.
export type CompanionAgentsModuleRegistry = {
  attach(moduleId: string, spec: CompanionAgentSpec): CompanionAgentHandle
}

export function createCompanionAgentsModuleRegistry(input: {
  service: CompanionAgentService
  /** The permissions the module declared in its manifest (disclosure list). */
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
  /** The ceiling of the agent whose tool call into the module is running, if any. */
  getCallerPermissionCeiling?: () => CliPermissionPreset | null
}): CompanionAgentsModuleRegistry {
  const callerCeiling = input.getCallerPermissionCeiling ?? moduleToolCallerCeiling
  // One module handle per app handle, so a second attach of the same companion
  // is the same handle here too.
  const handles = new WeakMap<CompanionAgentHandle, CompanionAgentHandle>()
  const declared = (moduleId: string): readonly string[] => input.getModulePermissions(moduleId) ?? []

  function moduleHandle(moduleId: string, handle: CompanionAgentHandle): CompanionAgentHandle {
    return {
      workspaceId: handle.workspaceId,
      agentId: handle.agentId,
      status: () => handle.status(),
      onStatus: (cb) => handle.onStatus(cb),
      runStructured: (opts) => {
        if (opts?.tools === 'auto') {
          const permissions = declared(moduleId)
          const ceiling: CliPermissionPreset = permissions.includes('conversation:bypass') ? 'bypass' : 'auto'
          if (!ceilingAllowsUnaskedTools(ceiling, callerCeiling())) {
            return Promise.reject(
              new Error(
                permissions.includes('conversation:bypass')
                  ? `Module "${moduleId}" cannot run a companion task with tools: 'auto' while it serves an agent's tool call that asks before acting.`
                  : `Module "${moduleId}" must declare the "conversation:bypass" permission to run a companion task with tools: 'auto', which approves every tool call without asking.`,
              ),
            )
          }
        }
        return handle.runStructured(opts)
      },
      send: (message) => handle.send(message),
      respondToApproval: async (answer) => {
        if (answer?.decision === 'once' && !declared(moduleId).includes('conversation:operate')) {
          return {
            ok: false,
            message: `Module "${moduleId}" must declare the "conversation:operate" permission to allow a tool call; without it a companion's approvals can only be denied.`,
          }
        }
        return handle.respondToApproval(answer)
      },
      onEvent: (cb) => handle.onEvent(cb),
      interrupt: () => handle.interrupt(),
      dispose: () => handle.dispose(),
    }
  }

  return {
    attach(moduleId, spec) {
      if (!declared(moduleId).includes('agents:companion')) {
        throw new Error(
          `Module "${moduleId}" must declare the "agents:companion" permission to attach a companion agent.`,
        )
      }
      const handle = input.service.attach({ ...spec, agentId: companionAgentIdFor(moduleId, spec.agentId) })
      let wrapped = handles.get(handle)
      if (!wrapped) {
        wrapped = moduleHandle(moduleId, handle)
        handles.set(handle, wrapped)
      }
      return wrapped
    },
  }
}

/** The agent id a module's companion runs under: its own id, inside the module's namespace. */
export function companionAgentIdFor(moduleId: string, agentId: string): string {
  return `companion-${moduleId}-${agentId}`
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function buildRetryPrompt(errors: string[]): string {
  const list = errors.map((error) => `- ${error}`).join('\n')
  return [
    'Your previous response could not be accepted:',
    list,
    '',
    'Reply again with ONLY the corrected JSON object and nothing else.',
  ].join('\n')
}

// Extract the final JSON value from streamed assistant text. Prefers the last
// fenced ```json block, then the outermost brace/bracket span, then the whole
// trimmed text. Returns undefined when nothing parses.
export function extractJson(text: string): unknown | undefined {
  const candidates: string[] = []
  const fenced = lastFencedBlock(text)
  if (fenced) candidates.push(fenced)
  const span = outermostJsonSpan(text)
  if (span) candidates.push(span)
  const trimmed = text.trim()
  if (trimmed) candidates.push(trimmed)
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

function lastFencedBlock(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  let last: string | null = null
  while ((match = fence.exec(text)) !== null) {
    const body = match[1]?.trim()
    if (body) last = body
  }
  return last
}

function outermostJsonSpan(text: string): string | null {
  const firstBrace = firstIndexOfAny(text, ['{', '['])
  const lastBrace = lastIndexOfAny(text, ['}', ']'])
  if (firstBrace < 0 || lastBrace <= firstBrace) return null
  return text.slice(firstBrace, lastBrace + 1)
}

function firstIndexOfAny(text: string, chars: string[]): number {
  let best = -1
  for (const char of chars) {
    const index = text.indexOf(char)
    if (index >= 0 && (best < 0 || index < best)) best = index
  }
  return best
}

function lastIndexOfAny(text: string, chars: string[]): number {
  let best = -1
  for (const char of chars) {
    const index = text.lastIndexOf(char)
    if (index > best) best = index
  }
  return best
}

// Redact secret-shaped keys from an event payload before it crosses IPC to a
// chat UI. Mirrors the runtime's on-disk redaction; token-usage numeric fields
// (`inputTokens`, `cacheReadTokens`, …) are preserved. Live listeners would
// otherwise receive un-redacted payloads (the runtime only redacts what it
// persists).
export function redactEvent(event: ConversationEvent): ConversationEvent {
  if (!event.payload) return event
  return JSON.parse(
    JSON.stringify(event, (key, value) => {
      // A count of tokens is a number and never a credential.
      if (/tokens$/i.test(key) && typeof value === 'number') return value
      if (typeof key === 'string' && /secret|token|api[-_]?key|authorization/i.test(key)) return '[redacted]'
      return value
    }),
  ) as ConversationEvent
}
