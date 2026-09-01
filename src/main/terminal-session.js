import { getTerminalHistoryTier, getTerminalReplayLimitBytes, TERMINAL_STANDARD_REPLAY_BYTES, } from '../shared/terminal-history';
const TERMINAL_REPLAY_COMPACT_THRESHOLD = 1024;
// Working/idle bolding for PLAIN terminals only: agent sessions' activity is
// bridged from their hook-reported phases (ingestAgentStateFrame), never from
// output timing — the agent idle-flip variant died with the status inference.
export const DEFAULT_IDLE_POLICY = {
    flipToIdleAfterMs: 3_000,
};
export function getTerminalSize(cols, rows) {
    return {
        cols: Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20),
        rows: Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8),
    };
}
export function isTerminalProcessAlive(session) {
    // A suspended session's pty has been killed to reclaim memory; it is not live
    // (so it un-bolds, drops out of resident memory, and is not re-reaped) but is
    // not gone either — `suspended` is its own state, distinct from exit/dispose.
    return !session.hasExited && !session.isDisposed && !session.suspended;
}
export function clearTerminalIdleTimer(session) {
    if (!session.idleTimer)
        return;
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
}
export function clearAgentStallTimer(session) {
    if (!session.agentStallTimer)
        return;
    clearTimeout(session.agentStallTimer);
    session.agentStallTimer = undefined;
}
// The lifecycle stamp an agent session is born with: `starting`, inferred —
// the one phase a fresh spawn can substantiate without a hook frame. The first
// reporter frame replaces it with authoritative state; a session whose hooks
// never fire (a broken install) converts to `stalled` via the stall watch
// instead of parking as working forever. Output-timing NEVER guesses a phase:
// the old inference (`inferAgentStateFromActivity`) was deleted outright —
// hooks are the only status mechanism (decision of record 2026-08-31), and
// every selectable agent CLI now reports them.
export function createInitialAgentState(kind, startedAt) {
    return kind === 'agent' ? { phase: 'starting', since: startedAt, source: 'inferred' } : undefined;
}
export function getTerminalIdleTimeoutMs(_session) {
    return DEFAULT_IDLE_POLICY.flipToIdleAfterMs;
}
export function createInitialTerminalActivity(startedAt) {
    return { kind: 'working', since: startedAt };
}
export function transitionTerminalActivity(session, next) {
    if (next.kind === 'exited' || next.kind === 'failed') {
        clearTerminalIdleTimer(session);
        clearAgentStallTimer(session);
        session.hasExited = true;
        session.exitedAt ??= next.at;
        session.exitCode = next.exitCode;
    }
    else if (!isTerminalProcessAlive(session)) {
        return false;
    }
    if (sessionActivitiesEqual(session.activity, next))
        return false;
    session.activity = next;
    return true;
}
export function recordTerminalInput(session, at = Date.now()) {
    session.lastInputAt = at;
}
// Visibility recency feeds the stale-terminal sweep. Both transitions count as
// "the user looked at this": becoming visible marks the view starting, and
// becoming hidden marks the moment the user navigated away.
export function recordTerminalVisibility(session, visible, at = Date.now()) {
    session.visible = visible;
    session.lastVisibleAt = at;
}
// A terminal with no mounted view (the separate visible guard below), no input,
// and no output for this long is reaped by the main-process sweep.
export const STALE_TERMINAL_MAX_UNSEEN_MS = 24 * 60 * 60 * 1000;
// "When real activity last happened on this terminal": the spawn moment plus the
// last genuine input or output. Deliberately EXCLUDES lastVisibleAt — merely
// opening a workspace or clicking a tab marks a terminal visible, and counting
// that would reset the idle clock every time the user just *looked*. Idle reaping
// must key off real interaction (typing) and real work (output), not attention.
// lastVisibleAt is still recorded for the snapshot/diagnostics, and the
// currently-on-screen guard lives separately in isTerminalSessionStale.
export function getTerminalLastSeenAt(session) {
    return Math.max(session.startedAt, session.lastInputAt ?? 0, session.lastOutputAt ?? 0);
}
export function isTerminalSessionStale(session, now = Date.now(), maxUnseenMs = STALE_TERMINAL_MAX_UNSEEN_MS) {
    if (session.isDisposed)
        return false;
    // A session with a mounted TerminalView is on screen somewhere; only treat
    // the visible flag as live while its window still exists.
    if (session.visible && !session.sender.isDestroyed())
        return false;
    return now - getTerminalLastSeenAt(session) > maxUnseenMs;
}
export function markTerminalExited(session, exitCode, at = Date.now()) {
    transitionTerminalActivity(session, { kind: 'exited', at, exitCode });
}
export function markTerminalFailed(session, exitCode, message, at = Date.now()) {
    transitionTerminalActivity(session, message
        ? { kind: 'failed', at, exitCode, message }
        : { kind: 'failed', at, exitCode });
}
export function createFailedTerminalSession(input) {
    const at = input.at ?? Date.now();
    const kind = input.kind ?? 'agent';
    return {
        sessionId: input.sessionId,
        process: createInactiveTerminalProcess(),
        sender: input.sender ?? createNoopWebContents(),
        isReady: true,
        hasExited: true,
        exitedAt: at,
        exitCode: input.exitCode ?? 1,
        isDisposed: false,
        activity: {
            kind: 'failed',
            at,
            exitCode: input.exitCode ?? 1,
            message: input.message,
        },
        // Lifecycle stamp, not inference: a retained failure IS the failed phase.
        ...(kind === 'agent' ? { agentState: { phase: 'failed', since: at, source: 'inferred' } } : {}),
        outputChunks: [],
        outputChunkBytes: [],
        outputChunkStart: 0,
        outputBytes: 0,
        outputLength: 0,
        kind: input.kind ?? 'agent',
        pathStyle: input.pathStyle,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        agentName: input.agentName,
        terminalId: input.terminalId,
        cli: input.cli,
        cwd: input.cwd,
        sprintEngineStatePath: input.sprintEngineStatePath,
        sprintEngineMcpRunId: input.sprintEngineMcpRunId,
        executionMode: input.executionMode,
        worktreeId: input.worktreeId,
        worktreePath: input.worktreePath,
        agentSession: input.agentSession,
        visible: input.visible ?? false,
        startedAt: at,
        lastOutputAt: input.lastOutputAt === undefined ? at : input.lastOutputAt,
        lastInputAt: input.lastInputAt ?? null,
        lastVisibleAt: input.visible ? at : null,
    };
}
// Durable freeze-the-view: materialize a suspended session from a persisted
// snapshot sidecar after an app restart, so the existing pause/replay/resume
// flow treats it exactly like a session suspended in this process: processAlive
// false, `suspended` true, painted content preferred from `replaySnapshot`.
// There is no pty and no SprintEngine run behind it; resume disposes it and
// re-spawns under the same session id.
export function createSuspendedPlaceholderSession(input) {
    const at = input.at ?? Date.now();
    const session = {
        sessionId: input.sessionId,
        process: createInactiveTerminalProcess(),
        sender: input.sender ?? createNoopWebContents(),
        isReady: true,
        hasExited: false,
        exitedAt: null,
        isDisposed: false,
        suspended: true,
        activity: { kind: 'idle', since: input.savedAt },
        // A frozen view is at rest by construction — stamped, not guessed from
        // output timing (an in-process suspend keeps the live phase; this is the
        // restart-rehydration path, where no phase survived).
        ...((input.kind ?? 'agent') === 'agent'
            ? { agentState: { phase: 'idle', since: input.savedAt, source: 'inferred' } }
            : {}),
        outputChunks: [],
        outputChunkBytes: [],
        outputChunkStart: 0,
        outputBytes: 0,
        outputLength: 0,
        replaySnapshot: input.replaySnapshot,
        kind: input.kind ?? 'agent',
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        terminalId: input.terminalId,
        cliSessionId: input.cliSessionId,
        cli: input.cli,
        cwd: input.cwd,
        executionMode: input.executionMode,
        worktreeId: input.worktreeId,
        worktreePath: input.worktreePath,
        agentSession: undefined,
        visible: false,
        // The rehydration moment, NOT savedAt: getTerminalLastSeenAt feeds the 24h
        // stale backstop, and dating the placeholder from its suspend time would let
        // the backstop dispose it (deleting the sidecar) the moment it reappears.
        startedAt: at,
        lastOutputAt: input.savedAt,
        lastInputAt: null,
        lastVisibleAt: null,
    };
    if (!input.replaySnapshot && input.rawReplay) {
        appendTerminalOutput(session, input.rawReplay, input.savedAt, false);
    }
    return session;
}
// `markAsRealOutput` lets the caller append bytes to the scrollback WITHOUT
// advancing `lastOutputAt`. Host-triggered repaints (an alt-screen TUI redrawing
// after a resize on mount/reveal) are real bytes but NOT agent activity, so they
// must keep the painted buffer complete while never bumping recency/liveness —
// otherwise opening a workspace makes its agents look "active" and reorders the
// sidebar. The repaint window is set in `safeResizeTerminal`.
export function appendTerminalOutput(session, data, at = Date.now(), markAsRealOutput = true) {
    const replayLimitBytes = getTerminalReplayLimitBytes({ ...session, lastOutputAt: at }, at);
    const chunk = trimTerminalChunkToReplayLimit(data, replayLimitBytes);
    session.outputChunks.push(chunk.data);
    session.outputChunkBytes.push(chunk.bytes);
    session.outputBytes += chunk.bytes;
    session.outputLength += chunk.data.length;
    if (markAsRealOutput)
        session.lastOutputAt = at;
    while (session.outputBytes > replayLimitBytes
        && session.outputChunkStart < session.outputChunks.length) {
        const removed = session.outputChunks[session.outputChunkStart];
        const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0;
        session.outputChunkStart += 1;
        session.outputBytes -= removedBytes;
        session.outputLength -= removed?.length ?? 0;
    }
    if (session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD
        && session.outputChunkStart > session.outputChunks.length / 2) {
        session.outputChunks.splice(0, session.outputChunkStart);
        session.outputChunkBytes.splice(0, session.outputChunkStart);
        session.outputChunkStart = 0;
    }
}
export function materializeTerminalReplay(session) {
    compactTerminalReplayToLimit(session);
    return session.outputChunks.slice(session.outputChunkStart).join('');
}
export function getTerminalSnapshot(session) {
    compactTerminalReplayToLimit(session);
    return {
        sessionId: session.sessionId,
        processAlive: isTerminalProcessAlive(session),
        kind: session.kind,
        pathStyle: session.pathStyle,
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        agentName: session.agentName,
        terminalId: session.terminalId,
        cliSessionId: session.cliSessionId,
        cli: session.cli,
        cwd: session.cwd,
        sprintEngineStatePath: session.sprintEngineStatePath,
        executionMode: session.executionMode,
        worktreeId: session.worktreeId,
        worktreePath: session.worktreePath,
        agentSession: session.agentSession,
        agentRecord: session.agentRecord,
        visible: session.visible,
        suspended: session.suspended ?? false,
        reapExempt: session.reapExempt ?? false,
        startedAt: session.startedAt,
        lastOutputAt: session.lastOutputAt,
        lastInputAt: session.lastInputAt,
        lastVisibleAt: session.lastVisibleAt,
        activity: session.activity,
        // Verbatim: agents carry lifecycle-stamped state from birth (`starting`
        // at spawn, hook frames thereafter, `stalled`/`exited`/`failed` from the
        // watchdog and pty lifecycle). Nothing is guessed from output timing, and
        // plain terminals carry none.
        agentState: session.agentState,
        lastPrompt: session.lastPrompt,
        exitedAt: session.exitedAt,
        outputBufferLength: session.outputLength,
        retainedOutputBytes: session.outputBytes,
        historyTier: getTerminalHistoryTier(session),
        replayLimitBytes: getTerminalReplayLimitBytes(session),
    };
}
function compactTerminalReplayToLimit(session, now = Date.now()) {
    const replayLimitBytes = getTerminalReplayLimitBytes(session, now);
    while (session.outputBytes > replayLimitBytes
        && session.outputChunks.length - session.outputChunkStart > 1) {
        const removed = session.outputChunks[session.outputChunkStart];
        const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0;
        session.outputChunkStart += 1;
        session.outputBytes -= removedBytes;
        session.outputLength -= removed?.length ?? 0;
    }
    if (session.outputBytes > replayLimitBytes
        && session.outputChunks.length - session.outputChunkStart === 1) {
        const index = session.outputChunkStart;
        const chunk = session.outputChunks[index] ?? '';
        const trimmed = trimTerminalChunkToReplayLimit(chunk, replayLimitBytes);
        session.outputChunks[index] = trimmed.data;
        session.outputChunkBytes[index] = trimmed.bytes;
        session.outputBytes = trimmed.bytes;
        session.outputLength = trimmed.data.length;
    }
    if (session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD
        && session.outputChunkStart > session.outputChunks.length / 2) {
        session.outputChunks.splice(0, session.outputChunkStart);
        session.outputChunkBytes.splice(0, session.outputChunkStart);
        session.outputChunkStart = 0;
    }
}
function trimTerminalChunkToReplayLimit(data, replayLimitBytes = TERMINAL_STANDARD_REPLAY_BYTES) {
    const bytes = Buffer.byteLength(data);
    if (bytes <= replayLimitBytes)
        return { data, bytes };
    const trimmed = Buffer.from(data)
        .subarray(bytes - replayLimitBytes)
        .toString('utf8');
    return {
        data: trimmed,
        bytes: Buffer.byteLength(trimmed),
    };
}
function sessionActivitiesEqual(first, second) {
    if (first.kind !== second.kind)
        return false;
    if (first.kind === 'working' && second.kind === 'working')
        return first.since === second.since;
    if (first.kind === 'idle' && second.kind === 'idle')
        return first.since === second.since;
    if (first.kind === 'exited' && second.kind === 'exited') {
        return first.at === second.at && first.exitCode === second.exitCode;
    }
    if (first.kind === 'failed' && second.kind === 'failed') {
        return first.at === second.at && first.exitCode === second.exitCode && first.message === second.message;
    }
    return false;
}
function createInactiveTerminalProcess() {
    return {
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
    };
}
function createNoopWebContents() {
    return {
        isDestroyed: () => true,
        send: () => undefined,
    };
}
/**
 * Event sink for sessions spawned with no window (sprint-runtime-ownership
 * Phase 3: headless scheduler spawns). Every outbound send is guarded on
 * `isDestroyed()`, so a headless session simply emits nothing until a window
 * attaches — the reattach path (`spawnTerminalFromIpc` existing-session
 * branch) then adopts the real WebContents and replays scrollback.
 */
export function createHeadlessTerminalSender() {
    return createNoopWebContents();
}
