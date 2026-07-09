import type { WebContents } from 'electron'
import type * as pty from 'node-pty'
import type {
  AgentCli,
  AgentExecutionMode,
  AgentSessionIdentity,
  AgentState,
  SessionActivity,
  TerminalKind,
  TerminalPathStyle,
  TerminalSessionSnapshot,
} from '../shared/electron-api'
import {
  getTerminalHistoryTier,
  getTerminalReplayLimitBytes,
  TERMINAL_STANDARD_REPLAY_BYTES,
} from '../shared/terminal-history'

export type TerminalSize = {
  cols: number
  rows: number
}

type FailedTerminalSessionInput = {
  sessionId: string
  sender?: WebContents
  message: string
  at?: number
  exitCode?: number
  kind?: TerminalKind
  pathStyle?: TerminalPathStyle
  workspaceId?: string
  agentId?: string
  agentName?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  sprintEngineStatePath?: string
  sprintEngineMcpRunId?: string
  sprintEngineRole?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  agentSession?: AgentSessionIdentity
  visible?: boolean
  lastOutputAt?: number | null
  lastInputAt?: number | null
}

export type TerminalSession = {
  sessionId: string
  process: pty.IPty
  sender: WebContents
  isReady: boolean
  hasExited: boolean
  exitedAt: number | null
  exitCode?: number
  isDisposed: boolean
  // Freeze-the-view: the agent process was killed to reclaim memory but the
  // session is kept (painted scrollback + --resume flags) so it can be resumed
  // on the next keystroke. Distinct from `isDisposed` (gone for good) and from a
  // real exit. `suspending` is the transient flag set just before `process.kill()`
  // so the pty `onExit` handler treats the death as a suspend, not a crash/exit.
  suspended?: boolean
  suspending?: boolean
  // User lock ("keep running"): while set, the reaper's idle-suspend and stale-
  // dispose sweeps skip this session entirely. Session-scoped; set over IPC from
  // the terminal's lock control.
  reapExempt?: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  // Watches a hook-reported working phase for a stall: a `tool_use`/`thinking`
  // agent that goes silent (no follow-up frame and no output) past the threshold
  // is flipped to an inferred `stalled` phase. See scheduleAgentStallCheck.
  agentStallTimer?: ReturnType<typeof setTimeout>
  activity: SessionActivity
  // Authoritative phase from the agent's lifecycle hooks, when the session's CLI
  // reports it. Layered on top of `activity` (which stays the inference floor);
  // absent until the first hook frame arrives. See agent-state.ts.
  agentState?: AgentState
  // When the agent self-scheduled a wakeup (ScheduleWakeup hook frame), the
  // epoch-ms time it fires. The timer lives inside the CLI process, so the idle
  // reaper holds the session until then (terminal-reap-policy). Cleared by a
  // stop frame, a SessionStart frame (a fresh/resumed process has no timer
  // from its previous life), or naturally by expiry.
  pendingWakeupAt?: number | null
  outputChunks: string[]
  outputChunkBytes: number[]
  outputChunkStart: number
  outputBytes: number
  outputLength: number
  // Faithful screen snapshot captured at suspend: the retained output stream is
  // rendered once through a headless terminal and serialized, so reopening a
  // paused agent repaints its last screen (including alternate-screen TUI state)
  // without a live process. Preferred over the raw `outputChunks` replay when
  // present; absent for live sessions and cleared on resume. See
  // terminal-replay-snapshot.ts.
  replaySnapshot?: string
  kind: TerminalKind
  pathStyle?: TerminalPathStyle
  workspaceId?: string
  agentId?: string
  // Display name from spawn metadata, surfaced on the snapshot so the session
  // manager can label agents that have no workspace.agents record.
  agentName?: string
  terminalId?: string
  // The agent's own session id within its CLI/harness, captured from lifecycle
  // hooks. Distinct from `sessionId` (our terminal-tracking id): this is the id
  // the CLI uses to resume the conversation. For Claude it equals our minted
  // id; Codex and others mint their own, learned via the hook after launch.
  cliSessionId?: string
  cli?: AgentCli
  cwd?: string
  sprintEngineStatePath?: string
  sprintEngineMcpRunId?: string
  sprintEngineRole?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  agentSession?: AgentSessionIdentity
  visible: boolean
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  lastVisibleAt: number | null
  pendingResize?: TerminalSize
  // Last dimensions actually applied to the pty. A reveal/tab-switch re-fits to
  // the SAME size; resizing the pty then makes the alt-screen TUI repaint, and
  // that repaint counts as spurious output/activity. Skip the resize when these
  // match so "last output" stays honest (real output, not repaints).
  appliedCols?: number
  appliedRows?: number
  // Output arriving before this time is treated as a host-triggered repaint (the
  // TUI redrawing after a resize), not agent activity: buffered but not counted
  // toward lastOutputAt / "working". Set in safeResizeTerminal.
  repaintGraceUntil?: number
  startupScriptPath?: string
}

const TERMINAL_REPLAY_COMPACT_THRESHOLD = 1024

export const DEFAULT_IDLE_POLICY = {
  flipToIdleAfterMs: 3_000,
  agentFlipToIdleAfterMs: 4_000,
} as const

export function getTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20),
    rows: Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8),
  }
}

export function isTerminalProcessAlive(session: TerminalSession): boolean {
  // A suspended session's pty has been killed to reclaim memory; it is not live
  // (so it un-bolds, drops out of resident memory, and is not re-reaped) but is
  // not gone either — `suspended` is its own state, distinct from exit/dispose.
  return !session.hasExited && !session.isDisposed && !session.suspended
}

export function clearTerminalIdleTimer(session: TerminalSession): void {
  if (!session.idleTimer) return
  clearTimeout(session.idleTimer)
  session.idleTimer = undefined
}

export function clearAgentStallTimer(session: TerminalSession): void {
  if (!session.agentStallTimer) return
  clearTimeout(session.agentStallTimer)
  session.agentStallTimer = undefined
}

// Derives an `inferred`-provenance AgentState from the legacy output-timing
// activity, for agent sessions whose CLI never reported a hook frame. This keeps
// every agent session exposing an AgentState with honest provenance (the spec's
// "agents without hook support keep today's behavior, marked inferred"); it can
// never produce `awaiting_input`, which is exactly why output-scraping needs the
// hooks. Used as the snapshot fallback when no hook/stall state is present.
export function inferAgentStateFromActivity(activity: SessionActivity): AgentState {
  switch (activity.kind) {
    case 'working':
      return { phase: 'thinking', since: activity.since, source: 'inferred' }
    case 'idle':
      return { phase: 'idle', since: activity.since, source: 'inferred' }
    case 'exited':
      return { phase: 'exited', since: activity.at, source: 'inferred' }
    case 'failed':
      return { phase: 'failed', since: activity.at, source: 'inferred' }
  }
}

export function getTerminalIdleTimeoutMs(session: TerminalSession): number {
  return session.kind === 'agent'
    ? DEFAULT_IDLE_POLICY.agentFlipToIdleAfterMs
    : DEFAULT_IDLE_POLICY.flipToIdleAfterMs
}

export function createInitialTerminalActivity(startedAt: number): SessionActivity {
  return { kind: 'working', since: startedAt }
}

export function transitionTerminalActivity(session: TerminalSession, next: SessionActivity): boolean {
  if (next.kind === 'exited' || next.kind === 'failed') {
    clearTerminalIdleTimer(session)
    clearAgentStallTimer(session)
    session.hasExited = true
    session.exitedAt ??= next.at
    session.exitCode = next.exitCode
  } else if (!isTerminalProcessAlive(session)) {
    return false
  }

  if (sessionActivitiesEqual(session.activity, next)) return false
  session.activity = next
  return true
}

export function markTerminalWorking(session: TerminalSession, at = Date.now()): boolean {
  if (!isTerminalProcessAlive(session)) return false
  session.lastOutputAt = at
  if (session.activity.kind === 'working') return false
  return transitionTerminalActivity(session, { kind: 'working', since: at })
}

export function recordTerminalInput(session: TerminalSession, at = Date.now()): void {
  session.lastInputAt = at
}

// Visibility recency feeds the stale-terminal sweep. Both transitions count as
// "the user looked at this": becoming visible marks the view starting, and
// becoming hidden marks the moment the user navigated away.
export function recordTerminalVisibility(
  session: TerminalSession,
  visible: boolean,
  at = Date.now()
): void {
  session.visible = visible
  session.lastVisibleAt = at
}

// A terminal with no mounted view (the separate visible guard below), no input,
// and no output for this long is reaped by the main-process sweep.
export const STALE_TERMINAL_MAX_UNSEEN_MS = 24 * 60 * 60 * 1000

// "When real activity last happened on this terminal": the spawn moment plus the
// last genuine input or output. Deliberately EXCLUDES lastVisibleAt — merely
// opening a workspace or clicking a tab marks a terminal visible, and counting
// that would reset the idle clock every time the user just *looked*. Idle reaping
// must key off real interaction (typing) and real work (output), not attention.
// lastVisibleAt is still recorded for the snapshot/diagnostics, and the
// currently-on-screen guard lives separately in isTerminalSessionStale.
export function getTerminalLastSeenAt(session: TerminalSession): number {
  return Math.max(
    session.startedAt,
    session.lastInputAt ?? 0,
    session.lastOutputAt ?? 0
  )
}

export function isTerminalSessionStale(
  session: TerminalSession,
  now = Date.now(),
  maxUnseenMs = STALE_TERMINAL_MAX_UNSEEN_MS
): boolean {
  if (session.isDisposed) return false
  // A session with a mounted TerminalView is on screen somewhere; only treat
  // the visible flag as live while its window still exists.
  if (session.visible && !session.sender.isDestroyed()) return false
  return now - getTerminalLastSeenAt(session) > maxUnseenMs
}

export function markTerminalIdle(session: TerminalSession, at = Date.now()): boolean {
  if (session.activity.kind !== 'working') return false
  return transitionTerminalActivity(session, { kind: 'idle', since: at })
}

export function markTerminalExited(session: TerminalSession, exitCode: number, at = Date.now()): void {
  transitionTerminalActivity(session, { kind: 'exited', at, exitCode })
}

export function markTerminalFailed(
  session: TerminalSession,
  exitCode: number,
  message: string | undefined,
  at = Date.now()
): void {
  transitionTerminalActivity(session, message
    ? { kind: 'failed', at, exitCode, message }
    : { kind: 'failed', at, exitCode })
}

export function createFailedTerminalSession(input: FailedTerminalSessionInput): TerminalSession {
  const at = input.at ?? Date.now()
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
  }
}

type SuspendedPlaceholderSessionInput = {
  sessionId: string
  sender?: WebContents
  // When the sidecar was written (the suspend/quit moment) — the honest "last
  // output" time for the painted content.
  savedAt: number
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cliSessionId?: string
  cwd?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  replaySnapshot?: string
  // Raw retained pty stream, used only when no serialized snapshot could be
  // built — seeds the replay buffer so reveal still paints something.
  rawReplay?: string
  at?: number
}

// Durable freeze-the-view: materialize a suspended session from a persisted
// snapshot sidecar after an app restart, so the existing pause/replay/resume
// flow treats it exactly like a session suspended in this process: processAlive
// false, `suspended` true, painted content preferred from `replaySnapshot`.
// There is no pty and no SprintEngine run behind it; resume disposes it and
// re-spawns under the same session id.
export function createSuspendedPlaceholderSession(
  input: SuspendedPlaceholderSessionInput
): TerminalSession {
  const at = input.at ?? Date.now()
  const session: TerminalSession = {
    sessionId: input.sessionId,
    process: createInactiveTerminalProcess(),
    sender: input.sender ?? createNoopWebContents(),
    isReady: true,
    hasExited: false,
    exitedAt: null,
    isDisposed: false,
    suspended: true,
    activity: { kind: 'idle', since: input.savedAt },
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
  }
  if (!input.replaySnapshot && input.rawReplay) {
    appendTerminalOutput(session, input.rawReplay, input.savedAt, false)
  }
  return session
}

// `markAsRealOutput` lets the caller append bytes to the scrollback WITHOUT
// advancing `lastOutputAt`. Host-triggered repaints (an alt-screen TUI redrawing
// after a resize on mount/reveal) are real bytes but NOT agent activity, so they
// must keep the painted buffer complete while never bumping recency/liveness —
// otherwise opening a workspace makes its agents look "active" and reorders the
// sidebar. The repaint window is set in `safeResizeTerminal`.
export function appendTerminalOutput(
  session: TerminalSession,
  data: string,
  at = Date.now(),
  markAsRealOutput = true
): void {
  const replayLimitBytes = getTerminalReplayLimitBytes({ ...session, lastOutputAt: at }, at)
  const chunk = trimTerminalChunkToReplayLimit(data, replayLimitBytes)
  session.outputChunks.push(chunk.data)
  session.outputChunkBytes.push(chunk.bytes)
  session.outputBytes += chunk.bytes
  session.outputLength += chunk.data.length
  if (markAsRealOutput) session.lastOutputAt = at

  while (
    session.outputBytes > replayLimitBytes
    && session.outputChunkStart < session.outputChunks.length
  ) {
    const removed = session.outputChunks[session.outputChunkStart]
    const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0
    session.outputChunkStart += 1
    session.outputBytes -= removedBytes
    session.outputLength -= removed?.length ?? 0
  }

  if (
    session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD
    && session.outputChunkStart > session.outputChunks.length / 2
  ) {
    session.outputChunks.splice(0, session.outputChunkStart)
    session.outputChunkBytes.splice(0, session.outputChunkStart)
    session.outputChunkStart = 0
  }
}

export function materializeTerminalReplay(session: TerminalSession): string {
  compactTerminalReplayToLimit(session)
  return session.outputChunks.slice(session.outputChunkStart).join('')
}

export function getTerminalSnapshot(session: TerminalSession): TerminalSessionSnapshot {
  compactTerminalReplayToLimit(session)
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
    visible: session.visible,
    suspended: session.suspended ?? false,
    reapExempt: session.reapExempt ?? false,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    lastInputAt: session.lastInputAt,
    lastVisibleAt: session.lastVisibleAt,
    activity: session.activity,
    // Hook/stall state when present; otherwise an inferred fallback so every
    // agent session carries provenance. Plain terminals carry none.
    agentState:
      session.agentState
      ?? (session.kind === 'agent' ? inferAgentStateFromActivity(session.activity) : undefined),
    exitedAt: session.exitedAt,
    outputBufferLength: session.outputLength,
    retainedOutputBytes: session.outputBytes,
    historyTier: getTerminalHistoryTier(session),
    replayLimitBytes: getTerminalReplayLimitBytes(session),
  }
}

function compactTerminalReplayToLimit(session: TerminalSession, now = Date.now()): void {
  const replayLimitBytes = getTerminalReplayLimitBytes(session, now)
  while (
    session.outputBytes > replayLimitBytes
    && session.outputChunks.length - session.outputChunkStart > 1
  ) {
    const removed = session.outputChunks[session.outputChunkStart]
    const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0
    session.outputChunkStart += 1
    session.outputBytes -= removedBytes
    session.outputLength -= removed?.length ?? 0
  }

  if (
    session.outputBytes > replayLimitBytes
    && session.outputChunks.length - session.outputChunkStart === 1
  ) {
    const index = session.outputChunkStart
    const chunk = session.outputChunks[index] ?? ''
    const trimmed = trimTerminalChunkToReplayLimit(chunk, replayLimitBytes)
    session.outputChunks[index] = trimmed.data
    session.outputChunkBytes[index] = trimmed.bytes
    session.outputBytes = trimmed.bytes
    session.outputLength = trimmed.data.length
  }

  if (
    session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD
    && session.outputChunkStart > session.outputChunks.length / 2
  ) {
    session.outputChunks.splice(0, session.outputChunkStart)
    session.outputChunkBytes.splice(0, session.outputChunkStart)
    session.outputChunkStart = 0
  }
}

function trimTerminalChunkToReplayLimit(data: string, replayLimitBytes = TERMINAL_STANDARD_REPLAY_BYTES): { data: string; bytes: number } {
  const bytes = Buffer.byteLength(data)
  if (bytes <= replayLimitBytes) return { data, bytes }

  const trimmed = Buffer.from(data)
    .subarray(bytes - replayLimitBytes)
    .toString('utf8')

  return {
    data: trimmed,
    bytes: Buffer.byteLength(trimmed),
  }
}

function sessionActivitiesEqual(first: SessionActivity, second: SessionActivity): boolean {
  if (first.kind !== second.kind) return false
  if (first.kind === 'working' && second.kind === 'working') return first.since === second.since
  if (first.kind === 'idle' && second.kind === 'idle') return first.since === second.since
  if (first.kind === 'exited' && second.kind === 'exited') {
    return first.at === second.at && first.exitCode === second.exitCode
  }
  if (first.kind === 'failed' && second.kind === 'failed') {
    return first.at === second.at && first.exitCode === second.exitCode && first.message === second.message
  }
  return false
}

function createInactiveTerminalProcess(): pty.IPty {
  return {
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as pty.IPty
}

function createNoopWebContents(): WebContents {
  return {
    isDestroyed: () => true,
    send: () => undefined,
  } as unknown as WebContents
}
