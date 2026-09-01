import type { AgentPhase, TerminalSessionSnapshot } from '../shared/electron-api';
import type { ConversationSessionSummary } from '../shared/conversation-runtime';
/**
 * The one main-process path that drives an agent session (MC-102).
 *
 * Every interaction — a Sprint Engine dispatch prompt, the review guide's
 * brief, an Automations action, a future composer or CLI — goes through this
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
export type ControlPlaneTransport = 'terminal' | 'conversation';
/**
 * A session as the control plane sees it: the identity fields every caller
 * addresses, normalized across the two runtimes so target resolution has one
 * shape to match against.
 */
export type ControlPlaneSession = {
    sessionId: string;
    transport: ControlPlaneTransport;
    alive: boolean;
    workspaceId?: string;
    agentId?: string;
    agentName?: string;
    cwd?: string;
    cli?: string;
    /**
     * The agent's lifecycle phase: hook-reported once frames arrive, lifecycle-
     * stamped (`starting`/`stalled`/`exited`/`failed`) otherwise — never guessed
     * from output timing (see `agent-state.ts`). Absent for plain shell
     * terminals, which have no agent to be idle or working.
     */
    phase?: AgentPhase;
    lastOutputAt?: number | null;
    lastInputAt?: number | null;
};
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
export type ControlPlaneTarget = string | {
    sessionId: string;
} | {
    agentId: string;
    workspaceId?: string;
} | {
    agentName: string;
} | {
    cwd: string;
} | {
    cli: string;
};
export type ControlPlaneFailureReason = 'invalid_target' | 'not_found' | 'ambiguous' | 'not_alive' | 'busy' | 'user_typing' | 'unsupported' | 'write_failed' | 'timeout';
export type ControlPlaneResolution = {
    ok: true;
    session: ControlPlaneSession;
} | {
    ok: false;
    reason: Extract<ControlPlaneFailureReason, 'invalid_target' | 'not_found' | 'ambiguous'>;
    message: string;
    /** Session ids that matched, when the target was ambiguous. */
    matches?: string[];
};
export type ControlPlaneSendResult = {
    ok: true;
    sessionId: string;
    transport: ControlPlaneTransport;
    /** True when the turn was submitted, false for a pre-fill left at the prompt. */
    submitted: boolean;
    /**
     * Only present when the caller asked for confirmation: whether the
     * session was observed reacting (a phase leaving idle, or fresh output)
     * inside the confirmation window. `false` means the turn was written but
     * nothing came back — an honest "unconfirmed", not a failure.
     */
    confirmed?: boolean;
} | {
    ok: false;
    sessionId?: string;
    reason: ControlPlaneFailureReason;
    message: string;
};
export type ControlPlaneReadResult = {
    ok: true;
    sessionId: string;
    text: string;
} | {
    ok: false;
    sessionId?: string;
    reason: ControlPlaneFailureReason;
    message: string;
};
export type ControlPlaneWaitResult = {
    ok: true;
    sessionId: string;
    matched: 'idle' | 'pattern';
} | {
    ok: false;
    sessionId?: string;
    reason: ControlPlaneFailureReason;
    message: string;
};
export type ControlPlaneSendOptions = {
    /** Submit the text as a turn. False leaves it pre-filled at the prompt. */
    submit?: boolean;
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
    waitForReady?: boolean;
    readyTimeoutMs?: number;
    /** Observe the session reacting to the submit instead of firing and forgetting. */
    confirm?: boolean;
    confirmTimeoutMs?: number;
    /** Gap between the pasted text and the carriage return that submits it. */
    submitDelayMs?: number;
};
export type ControlPlaneReadOptions = {
    /** Return only the last N lines of retained output. */
    lines?: number;
};
export type ControlPlaneWaitOptions = {
    /** Resolve once the session has produced no output for this long. */
    idleMs?: number;
    /** Resolve once retained output matches. */
    pattern?: RegExp;
    timeoutMs?: number;
    pollIntervalMs?: number;
};
export type ControlPlaneTerminalPort = {
    list(): TerminalSessionSnapshot[];
    write(sessionId: string, data: string): void;
    /** Retained scrollback for a live session; undefined when there is no such session. */
    read(sessionId: string): string | undefined;
};
export type ControlPlaneConversationPort = {
    list(): ConversationSessionSummary[];
    sendTurn(input: {
        sessionId: string;
        message: string;
    }): Promise<{
        ok: boolean;
        message?: string;
    }>;
    interrupt(input: {
        sessionId: string;
    }): Promise<{
        ok: boolean;
        message?: string;
    }>;
};
export type AgentControlPlaneDeps = {
    terminal: ControlPlaneTerminalPort;
    /**
     * Absent in hosts that run no conversation sessions. A target that resolves
     * to nothing then fails as `not_found`, which is the truth — it never
     * silently falls through to a PTY write.
     */
    conversation?: ControlPlaneConversationPort;
    now?: () => number;
    delay?: (ms: number) => Promise<void>;
};
export declare class AgentControlPlane {
    private readonly deps;
    private readonly now;
    private readonly delay;
    /** Per-session tail of the write chain. One writer per session, always. */
    private readonly queues;
    private readonly depths;
    /**
     * The `lastInputAt` this service itself put on a session. Both a human's
     * keystrokes and our own writes bump that timestamp, so without remembering
     * ours we would read every automated send as someone typing.
     */
    private readonly ownInputAt;
    constructor(deps: AgentControlPlaneDeps);
    /** Every session the plane can address, both transports, newest runtime state. */
    listSessions(): ControlPlaneSession[];
    resolve(target: ControlPlaneTarget): ControlPlaneResolution;
    /** How many operations are queued (including the running one) for a session. */
    queueDepth(sessionId: string): number;
    /**
     * Deliver `text` to a session: pre-fill it at the prompt, or pre-fill and
     * submit. The whole delivery occupies one queue slot, so a concurrent caller
     * cannot land between the text and its carriage return.
     */
    send(target: ControlPlaneTarget, text: string, options?: ControlPlaneSendOptions): Promise<ControlPlaneSendResult>;
    /** Send the carriage return that submits whatever is sitting at the prompt. */
    submit(target: ControlPlaneTarget): Promise<ControlPlaneSendResult>;
    /** Cancel whatever the session is doing: Ctrl-C on a PTY, an interrupt on a conversation. */
    interrupt(target: ControlPlaneTarget): Promise<ControlPlaneSendResult>;
    /**
     * Raw ordered write, for callers that own their own byte sequence (keystroke
     * forwarding, control characters). It takes the same per-session queue as
     * `send`, so a raw write and a prompt delivery cannot interleave — but it
     * carries none of the determinism: no bracketed paste, no separate submit.
     * Prefer `send` for anything that is a prompt.
     */
    write(target: ControlPlaneTarget, data: string): Promise<ControlPlaneSendResult>;
    /** Read a session's retained output. */
    read(target: ControlPlaneTarget, options?: ControlPlaneReadOptions): ControlPlaneReadResult;
    /**
     * Block until a session goes quiet or its output matches — the primitive a
     * scripted caller needs between two sends. Polls the runtime rather than
     * subscribing: the buffer is already the source of truth, and a poll cannot
     * miss a match that landed between two frames.
     */
    wait(target: ControlPlaneTarget, options?: ControlPlaneWaitOptions): Promise<ControlPlaneWaitResult>;
    private sendTerminalPrompt;
    private sendConversationTurn;
    /**
     * Hold until the session is idle/awaiting input AND nobody else has typed
     * into it recently, or the window expires. Both halves matter: pasting into
     * a working agent buffers the text into its next turn, and pasting over
     * someone's half-typed line mangles what they were writing.
     */
    private awaitReady;
    /**
     * Did the session actually take the turn? Either its phase left idle for a
     * working one, or it produced output it had not produced before the submit.
     * Both are weak on a hookless CLI — which is exactly why this reports a
     * boolean the caller can act on rather than throwing.
     */
    private awaitTurnAccepted;
    private isUserTyping;
    private isQuietFor;
    private writeTerminal;
    private findSession;
    private conversationUnavailable;
    /**
     * One writer per session. Each job runs only after the previous one settles,
     * and a job that throws does not poison the chain for the next caller.
     */
    private enqueue;
}
export declare function createAgentControlPlane(deps: AgentControlPlaneDeps): AgentControlPlane;
type ParsedTarget = {
    kind: 'sessionId';
    value: string;
} | {
    kind: 'agentId';
    value: string;
    workspaceId?: string;
} | {
    kind: 'agentName';
    value: string;
} | {
    kind: 'cwd';
    value: string;
} | {
    kind: 'cli';
    value: string;
};
export declare function parseTarget(target: ControlPlaneTarget): ParsedTarget | null;
export declare function toTerminalSession(snapshot: TerminalSessionSnapshot): ControlPlaneSession;
export declare function toConversationSession(summary: ConversationSessionSummary): ControlPlaneSession;
export {};
