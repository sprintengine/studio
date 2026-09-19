import type { AgentPhase, TerminalSessionSnapshot } from '../shared/electron-api'
import type { ConversationSessionSummary } from '../shared/conversation-runtime'
import { bracketedTerminalPaste } from '../shared/terminal-paste'

/**
 * The one main-process path that drives an agent session.
 *
 * Every interaction — the review guide's brief, an Automations action, a
 * future composer or CLI — goes through this
 * service instead of reaching for `pty.write()` on its own. What that buys:
 *
 * - **Single writer per session.** Concurrent callers are serialized on a
 *   per-session queue, so two prompts can never interleave their bytes into
 *   one garbled line. A whole `send` (paste + submit) is ONE queue entry, so
 *   nothing slips between the text and its carriage return.
 * - **Submit determinism in one place.** Bracketed paste for the text, a
 *   separately-dispatched carriage return for submit, and an optional turn
 *   confirmation — instead of each feature reinventing the pair.
 * - **Per-transport dispatch.** A session is addressed by identity, not by
 *   runtime: PTY sessions take the write queue, conversation sessions
 *   (`conversation-runtime.ts`) take a structured message send. Routing by
 *   transport is the point — writing `\r` at a conversation session does
 *   nothing and reports success.
 * - **Headless safety.** It lives in main and holds no window reference, so it
 *   works with every window closed.
 *
 * What it deliberately does NOT do yet: hold a durable prompt queue across
 * renderer reloads (the item's Phase 3, which the composer consumes). The
 * readiness gate and turn confirmation below are the primitives that queue is
 * built from; they are opt-in per call so migrating an existing writer onto
 * this service is a consolidation, not a behavior change.
 */

type ControlPlaneTransport = 'terminal' | 'conversation'

/**
 * A session as the control plane sees it: the identity fields every caller
 * addresses, normalized across the two runtimes so target resolution has one
 * shape to match against.
 */
export type ControlPlaneSession = {
  sessionId: string
  transport: ControlPlaneTransport
  alive: boolean
  workspaceId?: string
  agentId?: string
  agentName?: string
  cwd?: string
  cli?: string
  /**
   * The agent's lifecycle phase: hook-reported once frames arrive, lifecycle-
   * stamped (`starting`/`stalled`/`exited`/`failed`) otherwise — never guessed
   * from output timing (see `agent-state.ts`). Absent for plain shell
   * terminals, which have no agent to be idle or working.
   */
  phase?: AgentPhase
  lastOutputAt?: number | null
  lastInputAt?: number | null
}

/**
 * How a caller names the session it wants.
 *
 * The string form is for external/scripted callers (the deferred `multicode`
 * CLI, MCP tools): a bare value is a session id, and a `<kind>:<value>` prefix
 * selects a substring match. The prefixes stop at `cli:` and deliberately do
 * not include a `cmdline:` — the runtime retains the agent's CLI id and cwd,
 * never its argv, so matching a command line we do not keep would be an
 * invented answer.
 */
export type ControlPlaneTarget =
  | string
  | { sessionId: string }
  | { agentId: string; workspaceId?: string }
  | { agentName: string }
  | { cwd: string }
  | { cli: string }

type ControlPlaneFailureReason =
  | 'invalid_target'
  | 'not_found'
  | 'ambiguous'
  | 'not_alive'
  | 'busy'
  | 'user_typing'
  | 'unsupported'
  | 'write_failed'
  | 'timeout'

export type ControlPlaneResolution =
  | { ok: true; session: ControlPlaneSession }
  | {
      ok: false
      reason: Extract<ControlPlaneFailureReason, 'invalid_target' | 'not_found' | 'ambiguous'>
      message: string
      /** Session ids that matched, when the target was ambiguous. */
      matches?: string[]
    }

export type ControlPlaneSendResult =
  | {
      ok: true
      sessionId: string
      transport: ControlPlaneTransport
      /** True when the turn was submitted, false for a pre-fill left at the prompt. */
      submitted: boolean
      /**
       * Only present when the caller asked for confirmation: whether the
       * session was observed reacting (a phase leaving idle, or fresh output)
       * inside the confirmation window. `false` means the turn was written but
       * nothing came back — an honest "unconfirmed", not a failure.
       */
      confirmed?: boolean
    }
  | {
      ok: false
      sessionId?: string
      reason: ControlPlaneFailureReason
      message: string
    }

export type ControlPlaneReadResult =
  | { ok: true; sessionId: string; text: string }
  | { ok: false; sessionId?: string; reason: ControlPlaneFailureReason; message: string }

export type ControlPlaneWaitResult =
  | { ok: true; sessionId: string; matched: 'idle' | 'pattern' }
  | { ok: false; sessionId?: string; reason: ControlPlaneFailureReason; message: string }

export type ControlPlaneSendOptions = {
  /** Submit the text as a turn. False leaves it pre-filled at the prompt. */
  submit?: boolean
  /**
   * Hold the send until the session is idle/awaiting input and no one has
   * typed into it recently. Off by default: today's writers paste
   * unconditionally, and switching them to a gated send would change behavior,
   * not just consolidate it. The durable state-gated queue turns this on.
   *
   * The gate waits INSIDE the session's queue, so ordering is preserved — and
   * so anything else queued for that session (including an `interrupt`) waits
   * behind it, up to `readyTimeoutMs`. Gating outside the queue would let a
   * sibling send make the agent busy again between the gate and the paste,
   * which is the collision the gate exists to prevent.
   */
  waitForReady?: boolean
  readyTimeoutMs?: number
  /** Observe the session reacting to the submit instead of firing and forgetting. */
  confirm?: boolean
  confirmTimeoutMs?: number
  /** Gap between the pasted text and the carriage return that submits it. */
  submitDelayMs?: number
}

export type ControlPlaneReadOptions = {
  /** Return only the last N lines of retained output. */
  lines?: number
}

export type ControlPlaneWaitOptions = {
  /** Resolve once the session has produced no output for this long. */
  idleMs?: number
  /** Resolve once retained output matches. */
  pattern?: RegExp
  timeoutMs?: number
  pollIntervalMs?: number
}

type ControlPlaneTerminalPort = {
  list(): TerminalSessionSnapshot[]
  write(sessionId: string, data: string): void
  /** Retained scrollback for a live session; undefined when there is no such session. */
  read(sessionId: string): string | undefined
}

export type ControlPlaneConversationPort = {
  list(): ConversationSessionSummary[]
  sendTurn(input: { sessionId: string; message: string }): Promise<{ ok: boolean; message?: string }>
  interrupt(input: { sessionId: string }): Promise<{ ok: boolean; message?: string }>
}

export type AgentControlPlaneDeps = {
  terminal: ControlPlaneTerminalPort
  /**
   * Absent in hosts that run no conversation sessions. A target that resolves
   * to nothing then fails as `not_found`, which is the truth — it never
   * silently falls through to a PTY write.
   */
  conversation?: ControlPlaneConversationPort
  now?: () => number
  delay?: (ms: number) => Promise<void>
}

const DEFAULT_SUBMIT_DELAY_MS = 50
const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_CONFIRM_TIMEOUT_MS = 5_000
const DEFAULT_WAIT_TIMEOUT_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 100
/**
 * How long after someone else's keystroke an automated send stands down. The
 * race the item names: a queue flush and a human typing in the same pane
 * collide into one unreadable prompt line, and the human's text is the one
 * that gets mangled.
 */
const USER_TYPING_QUIET_MS = 1_500

const READY_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>(['idle', 'awaiting_input'])
/** Phases that mean the session took the turn: it is no longer sitting idle. */
const WORKING_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>(['thinking', 'tool_use', 'starting'])

const CTRL_C = '\x03'

export class AgentControlPlane {
  private readonly deps: AgentControlPlaneDeps
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>
  /** Per-session tail of the write chain. One writer per session, always. */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly depths = new Map<string, number>()
  /**
   * The `lastInputAt` this service itself put on a session. Both a human's
   * keystrokes and our own writes bump that timestamp, so without remembering
   * ours we would read every automated send as someone typing.
   */
  private readonly ownInputAt = new Map<string, number>()

  constructor(deps: AgentControlPlaneDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Every session the plane can address, both transports, newest runtime state. */
  listSessions(): ControlPlaneSession[] {
    const terminals = this.deps.terminal.list().map(toTerminalSession)
    const conversations = this.deps.conversation?.list().map(toConversationSession) ?? []
    return [...terminals, ...conversations]
  }

  resolve(target: ControlPlaneTarget): ControlPlaneResolution {
    const parsed = parseTarget(target)
    if (!parsed) {
      return {
        ok: false,
        reason: 'invalid_target',
        message: 'Agent target is empty. Name a session id, agent, cwd:, or cli:.',
      }
    }

    const sessions = this.listSessions()
    const matches = sessions.filter((session) => matchesTarget(session, parsed))
    // A dead session is still a legitimate answer to "which session did you
    // mean" — reporting `not_alive` beats reporting `not_found` for a terminal
    // the caller can see in the UI. But a live match always wins over a dead
    // one, so a respawned agent is never addressed at its corpse.
    const live = matches.filter((session) => session.alive)
    const candidates = live.length > 0 ? live : matches

    if (candidates.length === 0) {
      return { ok: false, reason: 'not_found', message: `No agent session matches ${describeTarget(parsed)}.` }
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: `${candidates.length} agent sessions match ${describeTarget(parsed)}. Name one by session id.`,
        matches: candidates.map((session) => session.sessionId),
      }
    }
    return { ok: true, session: candidates[0] }
  }

  /** How many operations are queued (including the running one) for a session. */
  queueDepth(sessionId: string): number {
    return this.depths.get(sessionId) ?? 0
  }

  /**
   * Deliver `text` to a session: pre-fill it at the prompt, or pre-fill and
   * submit. The whole delivery occupies one queue slot, so a concurrent caller
   * cannot land between the text and its carriage return.
   */
  async send(
    target: ControlPlaneTarget,
    text: string,
    options: ControlPlaneSendOptions = {},
  ): Promise<ControlPlaneSendResult> {
    const resolution = this.resolve(target)
    if (!resolution.ok) return resolution
    const session = resolution.session
    if (!session.alive) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'not_alive',
        message: `Agent session ${session.sessionId} is no longer running.`,
      }
    }
    if (!text) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'invalid_target',
        message: 'Agent send needs text to deliver.',
      }
    }

    const submit = options.submit ?? true
    if (session.transport === 'conversation') {
      // A conversation session has no prompt line to pre-fill: a message is
      // either sent as a turn or not sent at all. Say so rather than writing
      // nothing and reporting success.
      if (!submit) {
        return {
          ok: false,
          sessionId: session.sessionId,
          reason: 'unsupported',
          message: 'A conversation session cannot pre-fill text without sending it as a turn.',
        }
      }
      return this.enqueue(session.sessionId, () => this.sendConversationTurn(session, text))
    }

    return this.enqueue(session.sessionId, () => this.sendTerminalPrompt(session.sessionId, text, submit, options))
  }

  /** Send the carriage return that submits whatever is sitting at the prompt. */
  async submit(target: ControlPlaneTarget): Promise<ControlPlaneSendResult> {
    const resolution = this.resolve(target)
    if (!resolution.ok) return resolution
    const session = resolution.session
    if (session.transport === 'conversation') {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'unsupported',
        message: 'A conversation session has no deferred submit; send the message as a turn instead.',
      }
    }
    if (!session.alive) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'not_alive',
        message: `Agent session ${session.sessionId} is no longer running.`,
      }
    }
    return this.enqueue<ControlPlaneSendResult>(session.sessionId, async () => {
      const written = this.writeTerminal(session.sessionId, '\r')
      if (!written.ok) return written
      return { ok: true, sessionId: session.sessionId, transport: 'terminal', submitted: true }
    })
  }

  /** Cancel whatever the session is doing: Ctrl-C on a PTY, an interrupt on a conversation. */
  async interrupt(target: ControlPlaneTarget): Promise<ControlPlaneSendResult> {
    const resolution = this.resolve(target)
    if (!resolution.ok) return resolution
    const session = resolution.session
    if (!session.alive) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'not_alive',
        message: `Agent session ${session.sessionId} is no longer running.`,
      }
    }

    if (session.transport === 'conversation') {
      const conversation = this.deps.conversation
      if (!conversation) return this.conversationUnavailable(session.sessionId)
      return this.enqueue<ControlPlaneSendResult>(session.sessionId, async () => {
        const result = await conversation.interrupt({ sessionId: session.sessionId })
        if (!result.ok) {
          return {
            ok: false,
            sessionId: session.sessionId,
            reason: 'write_failed',
            message: result.message ?? 'Conversation interrupt failed.',
          }
        }
        return { ok: true, sessionId: session.sessionId, transport: 'conversation', submitted: false }
      })
    }

    return this.enqueue<ControlPlaneSendResult>(session.sessionId, async () => {
      const written = this.writeTerminal(session.sessionId, CTRL_C)
      if (!written.ok) return written
      return { ok: true, sessionId: session.sessionId, transport: 'terminal', submitted: false }
    })
  }

  /**
   * Raw ordered write, for callers that own their own byte sequence (keystroke
   * forwarding, control characters). It takes the same per-session queue as
   * `send`, so a raw write and a prompt delivery cannot interleave — but it
   * carries none of the determinism: no bracketed paste, no separate submit.
   * Prefer `send` for anything that is a prompt.
   */
  async write(target: ControlPlaneTarget, data: string): Promise<ControlPlaneSendResult> {
    const resolution = this.resolve(target)
    if (!resolution.ok) return resolution
    const session = resolution.session
    if (session.transport === 'conversation') {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'unsupported',
        message: 'A conversation session takes messages, not raw terminal writes.',
      }
    }
    if (!session.alive) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'not_alive',
        message: `Agent session ${session.sessionId} is no longer running.`,
      }
    }
    return this.enqueue<ControlPlaneSendResult>(session.sessionId, async () => {
      const written = this.writeTerminal(session.sessionId, data)
      if (!written.ok) return written
      return { ok: true, sessionId: session.sessionId, transport: 'terminal', submitted: false }
    })
  }

  /** Read a session's retained output. */
  read(target: ControlPlaneTarget, options: ControlPlaneReadOptions = {}): ControlPlaneReadResult {
    const resolution = this.resolve(target)
    if (!resolution.ok) return resolution
    const session = resolution.session
    if (session.transport === 'conversation') {
      // The conversation transport streams structured events into a JSONL
      // transcript; there is no scrollback to tail. Reading one is its own
      // surface (`conversationTranscript`), not this API pretending to have it.
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'unsupported',
        message: 'A conversation session has no terminal scrollback; read its transcript instead.',
      }
    }

    const text = this.deps.terminal.read(session.sessionId)
    if (text === undefined) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'not_found',
        message: `Agent session ${session.sessionId} has no retained output.`,
      }
    }
    return { ok: true, sessionId: session.sessionId, text: tailLines(text, options.lines) }
  }

  /**
   * Block until a session goes quiet or its output matches — the primitive a
   * scripted caller needs between two sends. Polls the runtime rather than
   * subscribing: the buffer is already the source of truth, and a poll cannot
   * miss a match that landed between two frames.
   */
  async wait(target: ControlPlaneTarget, options: ControlPlaneWaitOptions = {}): Promise<ControlPlaneWaitResult> {
    const resolution = this.resolve(target)
    if (!resolution.ok) return resolution
    const session = resolution.session
    if (session.transport === 'conversation') {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'unsupported',
        message: 'Waiting on output is a terminal-transport operation.',
      }
    }
    if (options.idleMs === undefined && !options.pattern) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'invalid_target',
        message: 'Agent wait needs an idle window or a pattern.',
      }
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const deadline = this.now() + timeoutMs

    for (;;) {
      const current = this.findSession(session.sessionId)
      if (!current) {
        return {
          ok: false,
          sessionId: session.sessionId,
          reason: 'not_found',
          message: `Agent session ${session.sessionId} disappeared while waiting.`,
        }
      }

      if (options.pattern) {
        const text = this.deps.terminal.read(session.sessionId)
        if (text !== undefined && options.pattern.test(text)) {
          return { ok: true, sessionId: session.sessionId, matched: 'pattern' }
        }
      }

      if (options.idleMs !== undefined && this.isQuietFor(current, options.idleMs)) {
        return { ok: true, sessionId: session.sessionId, matched: 'idle' }
      }

      // A session that has exited will never match or go busy again; waiting
      // out the full timeout on a corpse only delays the caller's error.
      if (!current.alive) {
        return {
          ok: false,
          sessionId: session.sessionId,
          reason: 'not_alive',
          message: `Agent session ${session.sessionId} stopped before the wait was satisfied.`,
        }
      }

      if (this.now() >= deadline) {
        return {
          ok: false,
          sessionId: session.sessionId,
          reason: 'timeout',
          message: `Agent session ${session.sessionId} did not satisfy the wait within ${timeoutMs}ms.`,
        }
      }
      await this.delay(pollIntervalMs)
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async sendTerminalPrompt(
    sessionId: string,
    text: string,
    submit: boolean,
    options: ControlPlaneSendOptions,
  ): Promise<ControlPlaneSendResult> {
    if (options.waitForReady) {
      const gate = await this.awaitReady(sessionId, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
      if (!gate.ok) return gate
    }

    const before = this.findSession(sessionId)
    if (!before || !before.alive) {
      return {
        ok: false,
        sessionId,
        reason: 'not_alive',
        message: `Agent session ${sessionId} is no longer running.`,
      }
    }

    const pasted = this.writeTerminal(sessionId, bracketedTerminalPaste(text))
    if (!pasted.ok) return pasted
    if (!submit) return { ok: true, sessionId, transport: 'terminal', submitted: false }

    // The carriage return is dispatched separately from the paste on purpose:
    // a CR inside the bracketed block is literal text to the agent's line
    // editor, not the Enter key that submits the turn.
    const submitDelayMs = options.submitDelayMs ?? DEFAULT_SUBMIT_DELAY_MS
    if (submitDelayMs > 0) await this.delay(submitDelayMs)
    const submitted = this.writeTerminal(sessionId, '\r')
    if (!submitted.ok) return submitted

    if (!options.confirm) return { ok: true, sessionId, transport: 'terminal', submitted: true }
    const confirmed = await this.awaitTurnAccepted(
      sessionId,
      before,
      options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
    )
    return { ok: true, sessionId, transport: 'terminal', submitted: true, confirmed }
  }

  private async sendConversationTurn(session: ControlPlaneSession, text: string): Promise<ControlPlaneSendResult> {
    const conversation = this.deps.conversation
    if (!conversation) return this.conversationUnavailable(session.sessionId)
    const result = await conversation.sendTurn({ sessionId: session.sessionId, message: text })
    if (!result.ok) {
      return {
        ok: false,
        sessionId: session.sessionId,
        reason: 'write_failed',
        message: result.message ?? 'Conversation turn was rejected.',
      }
    }
    return { ok: true, sessionId: session.sessionId, transport: 'conversation', submitted: true }
  }

  /**
   * Hold until the session is idle/awaiting input AND nobody else has typed
   * into it recently, or the window expires. Both halves matter: pasting into
   * a working agent buffers the text into its next turn, and pasting over
   * someone's half-typed line mangles what they were writing.
   */
  private async awaitReady(
    sessionId: string,
    timeoutMs: number,
  ): Promise<{ ok: true } | Extract<ControlPlaneSendResult, { ok: false }>> {
    const deadline = this.now() + timeoutMs
    for (;;) {
      const session = this.findSession(sessionId)
      if (!session) {
        return { ok: false, sessionId, reason: 'not_found', message: `Agent session ${sessionId} disappeared.` }
      }
      if (!session.alive) {
        return {
          ok: false,
          sessionId,
          reason: 'not_alive',
          message: `Agent session ${sessionId} is no longer running.`,
        }
      }

      const typing = this.isUserTyping(session)
      // No phase at all is a plain shell terminal: there is no agent turn to be
      // mid-way through, so readiness is only about the person at the keyboard.
      const ready = session.phase === undefined || READY_PHASES.has(session.phase)
      if (ready && !typing) return { ok: true }

      if (this.now() >= deadline) {
        return typing
          ? {
              ok: false,
              sessionId,
              reason: 'user_typing',
              message: `Agent session ${sessionId} is being typed into; the automated send stood down.`,
            }
          : {
              ok: false,
              sessionId,
              reason: 'busy',
              message: `Agent session ${sessionId} was still busy after ${timeoutMs}ms.`,
            }
      }
      await this.delay(DEFAULT_POLL_INTERVAL_MS)
    }
  }

  /**
   * Did the session actually take the turn? Either its phase left idle for a
   * working one, or it produced output it had not produced before the submit.
   * Both are weak on a hookless CLI — which is exactly why this reports a
   * boolean the caller can act on rather than throwing.
   */
  private async awaitTurnAccepted(sessionId: string, before: ControlPlaneSession, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    // A session that was ALREADY working before the submit proves nothing by
    // still working now — the prompt may simply be buffered behind the turn in
    // flight. Only a transition into a working phase counts as acceptance.
    const wasWorking = Boolean(before.phase && WORKING_PHASES.has(before.phase))
    for (;;) {
      const session = this.findSession(sessionId)
      if (!session) return false
      if (!wasWorking && session.phase && WORKING_PHASES.has(session.phase)) return true
      if (session.lastOutputAt != null && (before.lastOutputAt == null || session.lastOutputAt > before.lastOutputAt)) {
        return true
      }
      if (!session.alive || this.now() >= deadline) return false
      await this.delay(DEFAULT_POLL_INTERVAL_MS)
    }
  }

  private isUserTyping(session: ControlPlaneSession): boolean {
    if (session.lastInputAt == null) return false
    if (this.ownInputAt.get(session.sessionId) === session.lastInputAt) return false
    return this.now() - session.lastInputAt < USER_TYPING_QUIET_MS
  }

  private isQuietFor(session: ControlPlaneSession, idleMs: number): boolean {
    if (session.lastOutputAt == null) return true
    return this.now() - session.lastOutputAt >= idleMs
  }

  private writeTerminal(
    sessionId: string,
    data: string,
  ): { ok: true } | Extract<ControlPlaneSendResult, { ok: false }> {
    // The runtime's write is a no-op for a session that has exited or been
    // disposed, so without this check the plane would report a delivery that
    // never happened. Re-checked per write, not once per send: the second half
    // of a paste+submit pair can land after the agent died.
    const session = this.findSession(sessionId)
    if (!session || !session.alive) {
      return {
        ok: false,
        sessionId,
        reason: 'not_alive',
        message: `Agent session ${sessionId} is no longer running.`,
      }
    }
    try {
      this.deps.terminal.write(sessionId, data)
    } catch (error) {
      return {
        ok: false,
        sessionId,
        reason: 'write_failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    // Re-read the timestamp our own write just stamped, so the user-typing
    // guard can tell this service's input apart from a person's.
    const after = this.findSession(sessionId)
    if (after?.lastInputAt != null) this.ownInputAt.set(sessionId, after.lastInputAt)
    return { ok: true }
  }

  private findSession(sessionId: string): ControlPlaneSession | undefined {
    return this.listSessions().find((session) => session.sessionId === sessionId)
  }

  private conversationUnavailable(sessionId: string): Extract<ControlPlaneSendResult, { ok: false }> {
    return {
      ok: false,
      sessionId,
      reason: 'unsupported',
      message: 'This host runs no conversation transport.',
    }
  }

  /**
   * One writer per session. Each job runs only after the previous one settles,
   * and a job that throws does not poison the chain for the next caller.
   */
  private enqueue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(sessionId) ?? Promise.resolve()
    this.depths.set(sessionId, (this.depths.get(sessionId) ?? 0) + 1)
    const run = tail.then(job)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(sessionId, settled)
    void settled.then(() => {
      const depth = (this.depths.get(sessionId) ?? 1) - 1
      if (depth > 0) {
        this.depths.set(sessionId, depth)
        return
      }
      this.depths.delete(sessionId)
      // Drop the chain once it is drained so a long-lived app does not retain
      // a promise per session that ever received a write. The typing-guard
      // timestamp outlives the chain (it is what tells the NEXT send that the
      // last keystroke was ours), so it is dropped only once the session itself
      // is gone from the runtime.
      if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId)
      if (!this.findSession(sessionId)) this.ownInputAt.delete(sessionId)
    })
    return run
  }
}

export function createAgentControlPlane(deps: AgentControlPlaneDeps): AgentControlPlane {
  return new AgentControlPlane(deps)
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

type ParsedTarget =
  | { kind: 'sessionId'; value: string }
  | { kind: 'agentId'; value: string; workspaceId?: string }
  | { kind: 'agentName'; value: string }
  | { kind: 'cwd'; value: string }
  | { kind: 'cli'; value: string }

export function parseTarget(target: ControlPlaneTarget): ParsedTarget | null {
  if (typeof target !== 'string') {
    if ('sessionId' in target)
      return target.sessionId.trim() ? { kind: 'sessionId', value: target.sessionId.trim() } : null
    if ('agentId' in target) {
      const value = target.agentId.trim()
      return value ? { kind: 'agentId', value, workspaceId: target.workspaceId?.trim() || undefined } : null
    }
    if ('agentName' in target)
      return target.agentName.trim() ? { kind: 'agentName', value: target.agentName.trim() } : null
    if ('cwd' in target) return target.cwd.trim() ? { kind: 'cwd', value: target.cwd.trim() } : null
    if ('cli' in target) return target.cli.trim() ? { kind: 'cli', value: target.cli.trim() } : null
    return null
  }

  const spec = target.trim()
  if (!spec) return null
  const separator = spec.indexOf(':')
  if (separator <= 0) return { kind: 'sessionId', value: spec }
  const prefix = spec.slice(0, separator)
  const value = spec.slice(separator + 1).trim()
  if (!value) return null
  switch (prefix) {
    case 'session':
      return { kind: 'sessionId', value }
    case 'agent':
      return { kind: 'agentName', value }
    case 'agentId':
      return { kind: 'agentId', value }
    case 'cwd':
      return { kind: 'cwd', value }
    case 'cli':
      return { kind: 'cli', value }
    default:
      // An unprefixed value containing a colon (a Windows path, a compound id)
      // is a session id, not an unknown selector.
      return { kind: 'sessionId', value: spec }
  }
}

function matchesTarget(session: ControlPlaneSession, target: ParsedTarget): boolean {
  switch (target.kind) {
    case 'sessionId':
      return session.sessionId === target.value
    case 'agentId':
      if (session.agentId !== target.value) return false
      return !target.workspaceId || session.workspaceId === target.workspaceId
    case 'agentName':
      // Agent NAME is what a person types; agent id is what the app stores.
      // Accepting either keeps a scripted caller from needing to know which.
      return session.agentName?.toLowerCase() === target.value.toLowerCase() || session.agentId === target.value
    case 'cwd':
      return Boolean(session.cwd && session.cwd.includes(target.value))
    case 'cli':
      return Boolean(session.cli && session.cli.includes(target.value))
  }
}

function describeTarget(target: ParsedTarget): string {
  switch (target.kind) {
    case 'sessionId':
      return `session ${target.value}`
    case 'agentId':
      return target.workspaceId ? `agent ${target.value} in workspace ${target.workspaceId}` : `agent ${target.value}`
    case 'agentName':
      return `agent "${target.value}"`
    case 'cwd':
      return `cwd containing "${target.value}"`
    case 'cli':
      return `cli containing "${target.value}"`
  }
}

function toTerminalSession(snapshot: TerminalSessionSnapshot): ControlPlaneSession {
  return {
    sessionId: snapshot.sessionId,
    transport: 'terminal',
    alive: snapshot.processAlive,
    workspaceId: snapshot.workspaceId,
    agentId: snapshot.agentId,
    agentName: snapshot.agentName,
    cwd: snapshot.cwd,
    cli: snapshot.cli,
    phase: snapshot.agentState?.phase,
    lastOutputAt: snapshot.lastOutputAt,
    lastInputAt: snapshot.lastInputAt,
  }
}

function toConversationSession(summary: ConversationSessionSummary): ControlPlaneSession {
  return {
    sessionId: summary.sessionId,
    transport: 'conversation',
    alive: summary.status !== 'stopped' && summary.status !== 'failed',
    workspaceId: summary.workspaceId,
    agentId: summary.agentId,
    phase: conversationPhase(summary.status),
    // A conversation session streams events, not pty bytes; `updatedAt` is the
    // nearest honest "last activity" stamp. Nothing routes on it — `wait` and
    // turn confirmation are terminal-transport operations — so it is a listing
    // field, not a signal the plane acts upon.
    lastOutputAt: summary.updatedAt,
  }
}

function conversationPhase(status: ConversationSessionSummary['status']): AgentPhase {
  switch (status) {
    case 'starting':
      return 'starting'
    case 'ready':
      return 'idle'
    case 'active':
      return 'thinking'
    case 'awaiting_approval':
      return 'awaiting_input'
    case 'stopped':
      return 'exited'
    case 'failed':
      return 'failed'
  }
}

function tailLines(text: string, lines: number | undefined): string {
  if (lines === undefined || lines <= 0) return text
  const split = text.split('\n')
  if (split.length <= lines) return text
  return split.slice(split.length - lines).join('\n')
}
