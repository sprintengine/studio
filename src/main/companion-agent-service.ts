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
  /** Display name in the Sessions popover / Attention Queue. */
  name: string
  /**
   * Absolute workspace folder. The main process has no workspaceId → folder
   * registry (workspaceRoot is caller-supplied everywhere conversation sessions
   * are started), so the caller provides it here, exactly as
   * ConversationStartSessionInput requires.
   */
  workspaceRoot: string
  /** Engine selection; resolves to a provider/model pair (defaults claude-agent/sonnet). */
  engine?: { cli?: string; model?: string }
  /** Advisory context roots. The provider already resolves knowledge from workspaceRoot. */
  contextRoots?: { knowledge?: boolean }
  /** Role instructions, delivered as a preamble on the first turn. */
  systemPrompt: string
}

type CompanionValidateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

type CompanionRunStructuredOptions<T> = {
  prompt: string
  validate: (raw: unknown) => CompanionValidateResult<T>
  /** Validator errors are fed back to the agent and the turn retried. Default 1. */
  retries?: number
  onPhase?: (phase: string) => void
}

type Unsubscribe = () => void

type CompanionAgentHandle = {
  readonly workspaceId: string
  readonly agentId: string
  status(): CompanionAgentStatus
  onStatus(cb: (status: CompanionAgentStatus) => void): Unsubscribe
  runStructured<T>(opts: CompanionRunStructuredOptions<T>): Promise<T>
  send(message: string): Promise<void>
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
  autoApprove: boolean
  settle: (result: { ok: true; text: string } | { ok: false; message: string }) => void
  settled: boolean
}

type CompanionEntry = {
  spec: CompanionAgentSpec
  key: string
  sessionId: string | null
  disposed: boolean
  spawning: Promise<void> | null
  /** Delivered once, prepended to the first outgoing turn. */
  pendingPreamble: string | null
  lastStatus: CompanionAgentStatus
  statusListeners: Set<(status: CompanionAgentStatus) => void>
  eventListeners: Set<(event: ConversationEvent) => void>
  activeCollector: StructuredRunCollector | null
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

function defaultEngineDefaults(engine?: CompanionAgentSpec['engine']): { providerId: string; modelId: string } {
  return {
    providerId: engine?.cli?.trim() || DEFAULT_PROVIDER_ID,
    modelId: engine?.model?.trim() || DEFAULT_MODEL_ID,
  }
}

function entryKey(workspaceId: string, agentId: string): string {
  // NUL is not valid in either id, so it cannot collide with the ids themselves.
  return `${workspaceId} ${agentId}`
}

export function createCompanionAgentService(
  options: CreateCompanionAgentServiceOptions
): CompanionAgentService {
  const runtime = options.runtime
  const resolveEngineDefaults = options.resolveEngineDefaults ?? defaultEngineDefaults
  const entries = new Map<string, CompanionEntry>()

  // One subscription to the runtime, fanned out to entries by (workspaceId,
  // agentId). onStatus/onEvent are fed from here — never from output parsing.
  const unsubscribeRuntime = runtime.onEvent((event) => {
    const entry = entries.get(entryKey(event.workspaceId, event.agentId))
    if (!entry || entry.disposed) return
    if (entry.sessionId && event.sessionId !== entry.sessionId) return

    // Forward canonical (redacted) events to chat UIs.
    if (entry.eventListeners.size > 0) {
      const redacted = redactEvent(event)
      for (const listener of entry.eventListeners) listener(redacted)
    }

    // Drive an in-flight structured run off the raw turn-end events.
    const collector = entry.activeCollector
    if (collector && event.sessionId === collector.sessionId) {
      if (event.type === 'content_delta') {
        const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
        if (text) collector.text += text
      } else if (event.type === 'approval_requested' && collector.autoApprove) {
        // A structured run is autonomous; resolve the tool approval so the turn
        // can reach turn_completed. Deferred to a microtask so we never re-enter
        // the runtime mid-emit. Chat sends (send()) do NOT auto-approve.
        const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
        if (requestId && entry.sessionId) {
          const sessionId = entry.sessionId
          queueMicrotask(() => {
            void runtime
              .respondToRequest({ sessionId, requestId, approved: true })
              .catch(() => undefined)
          })
        }
      } else if (event.type === 'turn_completed') {
        settleCollector(collector, { ok: true, text: collector.text })
      } else if (event.type === 'turn_failed') {
        const message = typeof event.payload?.message === 'string'
          ? event.payload.message
          : typeof event.payload?.reason === 'string'
            ? String(event.payload.reason)
            : 'Companion turn failed.'
        settleCollector(collector, { ok: false, message })
      }
    }

    notifyStatus(entry)
  })

  function settleCollector(
    collector: StructuredRunCollector,
    result: { ok: true; text: string } | { ok: false; message: string }
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
    entry.spawning = (async () => {
      const started = await runtime.startSession({
        workspaceRoot: entry.spec.workspaceRoot,
        workspaceId: entry.spec.workspaceId,
        agentId: entry.spec.agentId,
        providerId,
        modelId,
      })
      if (!started.ok) {
        throw new Error(`Companion session could not start: ${started.message}`)
      }
      entry.sessionId = started.session.sessionId
      entry.pendingPreamble = entry.spec.systemPrompt.trim() || null
      notifyStatus(entry)
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
  async function runTurn(entry: CompanionEntry, message: string): Promise<string> {
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
      autoApprove: true,
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
    await ensureSpawned(entry)
    // One writer: a second concurrent structured run interrupts the first.
    if (entry.activeCollector) await interruptEntry(entry)

    const maxRetries = Math.max(0, opts.retries ?? 1)
    let message = consumePreamble(entry, opts.prompt)
    let lastErrors: string[] = []
    for (let attempt = 0; ; attempt += 1) {
      opts.onPhase?.(attempt === 0 ? 'running' : 'retrying')
      const text = await runTurn(entry, message)
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
        pendingPreamble: null,
        lastStatus: 'absent',
        statusListeners: new Set(),
        eventListeners: new Set(),
        activeCollector: null,
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
// It enforces the `agents:companion` permission at attach time — the only
// permission the platform actually gates, since there is no shared runtime
// permission broker to inherit — then delegates to the app's companion service.
export type CompanionAgentsModuleRegistry = {
  attach(moduleId: string, spec: CompanionAgentSpec): CompanionAgentHandle
}

export function createCompanionAgentsModuleRegistry(input: {
  service: CompanionAgentService
  /** The permissions the module declared in its manifest (disclosure list). */
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
}): CompanionAgentsModuleRegistry {
  return {
    attach(moduleId, spec) {
      const declared = input.getModulePermissions(moduleId) ?? []
      if (!declared.includes('agents:companion')) {
        throw new Error(
          `Module "${moduleId}" must declare the "agents:companion" permission to attach a companion agent.`
        )
      }
      return input.service.attach(spec)
    },
  }
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
// are preserved. Live listeners would otherwise receive un-redacted payloads
// (the runtime only redacts what it persists).
export function redactEvent(event: ConversationEvent): ConversationEvent {
  if (!event.payload) return event
  return JSON.parse(
    JSON.stringify(event, (key, value) => {
      if (key === 'inputTokens' || key === 'outputTokens' || key === 'totalTokens') return value
      if (typeof key === 'string' && /secret|token|api[-_]?key|authorization/i.test(key)) return '[redacted]'
      return value
    })
  ) as ConversationEvent
}
