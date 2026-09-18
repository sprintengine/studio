import type { WebContents } from 'electron'
import type { ObservedCheckout } from '../shared/observed-checkout'
import type { BranchPullRequest } from '../shared/git/pull-request'
import type * as pty from 'node-pty'
import type {
  AgentCli,
  AgentExecutionMode,
  AgentSessionIdentity,
  AgentState,
  SessionActivity,
  SessionContextUsage,
  SessionFileChange,
  SessionPrompt,
  TerminalKind,
  TerminalPathStyle,
  TerminalSessionSnapshot,
} from '../shared/electron-api'
import type { AgentLaunchRecord } from '../shared/agent-launch'
import type { AgentStateFrameStatusLine } from './agent-state'
import { isValidFileChangePath, MAX_AGENT_PROMPT_LENGTH, MAX_FILE_CHANGE_COUNT } from './agent-state'
import { MAX_LIVE_PEEK_PROMPTS } from './conversation-peek/service'
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
  /**
   * A module owns this session's lifetime (launch contribution `session.managed`).
   * The idle reaper excludes it from the recency floor that protects the user's
   * own agents. Distinct from `reapExempt`, which is the user's lock control.
   */
  managed?: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  // Watches a hook-reported working phase for a stall: a `tool_use`/`thinking`
  // agent that goes silent (no follow-up frame and no output) past the threshold
  // is flipped to an inferred `stalled` phase. See scheduleAgentStallCheck.
  agentStallTimer?: ReturnType<typeof setTimeout>
  activity: SessionActivity
  // The agent's phase. Lifecycle-stamped `starting` (inferred) at spawn, then
  // authoritative from the CLI's hook frames; the stall watchdog and the pty
  // exit path stamp `stalled`/`exited`/`failed`. Never derived from output
  // timing. Absent for plain terminals. See agent-state.ts.
  agentState?: AgentState
  // The last prompt the person submitted to this session, from the reporter's
  // `UserPromptSubmit` frame. Drives the terminal tab's hover preview ("what was
  // I working on here?") and names a new chat after its first real prompt.
  // Absent for plain terminals, for hookless CLIs, and until the first prompt.
  lastPrompt?: SessionPrompt
  // Every prompt this session has been sent since it launched, oldest first and
  // bounded (see rememberSessionPrompt). This is the conversation peek's LIVE
  // fallback: Codex, Grok and Kimi Code report `UserPromptSubmit` but hand us no
  // transcript, so without this the card for one of them could only ever show
  // the single most recent thing said.
  //
  // Persisted with the snapshot sidecar, and nowhere else — never the workspace
  // registry, never a log. That reverses the original decision to keep prompts
  // out of every file the app writes (the app that writes none cannot leak
  // any), and the reason is that the alternative was worse: a Codex chat is a
  // runtime with no transcript we can read, so on the far side of a restart the
  // card for one could only say it had no messages — about a chat whose own
  // title was its first prompt. The sidecar is the narrowest home for them: one
  // file per parked chat under userData, mode 0600, deleted on dispose and
  // swept at 30 days, holding a painted screen that already shows this text.
  peekPrompts?: SessionPrompt[]
  // Whether the retained replay has ever had its head cut off — a chunk evicted
  // past the byte budget, or an oversized chunk trimmed. Sticky, because
  // compaction renumbers the chunk list and `outputChunkStart` goes back to 0
  // while the cut stays made. It is what licenses the resync in
  // {@link materializeTerminalReplay}: an untouched buffer starts where the CLI
  // started and must be replayed byte for byte.
  replayTruncated?: boolean
  // The CLI's own transcript, as its turn-end hook last reported it. Retained so
  // the conversation peek can read the whole history on a hover instead of only
  // what this app happened to watch go by. UNTRUSTED — a path chosen by the hook
  // reporter — so containment belongs to the reader (conversation-peek/transcript.ts).
  transcriptPath?: string
  // When the agent's last turn ended (hook-reported Stop). Stamped in
  // ingestAgentStateFrame, carried across resume and through the snapshot
  // sidecar; never overwritten by suspend/exit. See the snapshot field.
  lastTurnEndedAt?: number | null
  // When the agent self-scheduled a wakeup (ScheduleWakeup hook frame), the
  // epoch-ms time it fires. The timer lives inside the CLI process, so the idle
  // reaper holds the session until then (terminal-reap-policy). Cleared by a
  // stop frame, a SessionStart frame (a fresh/resumed process has no timer
  // from its previous life), or naturally by expiry.
  pendingWakeupAt?: number | null
  // What this session has edited, keyed by absolute path. Fed by the
  // reporter's PostToolUse `fileChange` frames (ingestAgentStateFrame) and read
  // out newest-first for the snapshot. Insertion order IS the recency order:
  // every observation re-inserts its entry at the end (see
  // recordSessionFileChange), so the newest edit is always the last key.
  //
  // Lives and dies with the pty: a fresh session starts empty, and a resume
  // respawns the pty, so its ledger starts over too. A parked session keeps
  // its ledger through the snapshot sidecar, which is the only place it is
  // written down.
  fileChanges?: Map<string, SessionFileChange>
  // The file-change folds this session has already applied, newest last, so a
  // DUPLICATE frame is not counted twice.
  //
  // The app registers the agent-state reporter twice — merged by hand into
  // `.claude/settings.local.json`, and declared again by the studio plugin's
  // own `hooks/hooks.json` — and Claude Code 2.1.266 loads the plugin natively
  // whether or not this app asks it to, so both registrations fire on every
  // tool call. The two frames are identical, so without this the ledger read
  // exactly 2x the agent's edits and the changelist line tracker applied every
  // insert and delete twice, corrupting its spans.
  //
  // Keys are `noteFoldedFileChange`'s, values the frame ts they were folded at
  // (the no-id key needs it for its window). Bounded to
  // MAX_FOLDED_FILE_CHANGE_KEYS and evicted oldest-first: this is a duplicate
  // guard for frames seconds apart, not a history.
  //
  // In memory only, and deliberately not on the snapshot: a rehydrated session
  // is not going to receive the duplicate of a frame the pty that sent it no
  // longer exists to send.
  foldedFileChanges?: Map<string, FoldedFileChange>
  // The last reading from this session's own status line (the status-line
  // forwarder's `StatusLine` frames). Only `contextUsage` below is on the
  // snapshot today; the cost, the line counts, the model and the session name
  // are kept here for the surfaces that will read them, so the forwarder is
  // written once rather than once per consumer.
  statusLine?: SessionStatusLine
  // How much of the context window this session has consumed, as of the reading
  // that last MOVED it. A null percentage — which the CLI reports before its
  // first API call and again right after a /compact — deliberately does NOT
  // clear this: "not known right now" is not "empty", and painting a compacted
  // session as unknown would lose the number a person was watching seconds
  // before the next real reading replaces it.
  contextUsage?: SessionContextUsage
  // Background work the agent still owns — subagents started and not yet
  // stopped, per the manifest's `background` events. A turn end that arrives
  // while this is above zero is held as working (agent-state.ts,
  // holdTurnEndForBackgroundWork). Reset on a session start and on a stall.
  backgroundWork?: number
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
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  // Where the session's hooks last saw it (MC-2440): the reported cwd plus
  // git's answer for it. Kept apart from `cwd`/`worktreePath` (launch intent).
  observedCheckout?: ObservedCheckout
  // Monotonic ticket for the async git resolution of `observedCheckout`, so a
  // resolution that finishes after a newer cwd arrived is discarded.
  observedCheckoutSeq?: number
  agentSession?: AgentSessionIdentity
  // The launch decisions the main-process AgentLaunchService made for this
  // session (MC-2159). Retained here so it lives exactly as long as the session
  // does: the renderer projects a tab from it, and when the pty is gone there is
  // nothing left to project. Absent for renderer-launched and plain sessions.
  agentRecord?: AgentLaunchRecord
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
  /**
   * This session's host-context document, when the launch wrote one. Reaped
   * with the startup script at teardown — the file is per-session and rewritten
   * on every launch and resume, so nothing outlives the pty.
   */
  hostContextPath?: string
}

const TERMINAL_REPLAY_COMPACT_THRESHOLD = 1024

// Working/idle bolding for PLAIN terminals only: agent sessions' activity is
// bridged from their hook-reported phases (ingestAgentStateFrame), never from
// output timing — the agent idle-flip variant died with the status inference.
const DEFAULT_IDLE_POLICY = {
  flipToIdleAfterMs: 3_000,
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

// The lifecycle stamp an agent session is born with: `starting` — the one phase
// a fresh spawn can substantiate without a hook frame. The first
// reporter frame replaces it with authoritative state; a session whose hooks
// never fire (a broken install) converts to `stalled` via the stall watch
// instead of parking as working forever. Output-timing NEVER guesses a phase:
// the old inference (`inferAgentStateFromActivity`) was deleted outright —
// hooks are the only status mechanism (decision of record 2026-08-31), and
// every selectable agent CLI now reports them.
export function createInitialAgentState(kind: TerminalKind, startedAt: number): AgentState | undefined {
  return kind === 'agent' ? { phase: 'starting', since: startedAt, source: 'lifecycle' } : undefined
}

export function getTerminalIdleTimeoutMs(_session: TerminalSession): number {
  return DEFAULT_IDLE_POLICY.flipToIdleAfterMs
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

export function recordTerminalInput(session: TerminalSession, at = Date.now()): void {
  session.lastInputAt = at
}

// Visibility recency feeds the stale-terminal sweep. Both transitions count as
// "the user looked at this": becoming visible marks the view starting, and
// becoming hidden marks the moment the user navigated away.
export function recordTerminalVisibility(session: TerminalSession, visible: boolean, at = Date.now()): void {
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
  return Math.max(session.startedAt, session.lastInputAt ?? 0, session.lastOutputAt ?? 0)
}

export function isTerminalSessionStale(
  session: TerminalSession,
  now = Date.now(),
  maxUnseenMs = STALE_TERMINAL_MAX_UNSEEN_MS,
): boolean {
  if (session.isDisposed) return false
  // A session with a mounted TerminalView is on screen somewhere; only treat
  // the visible flag as live while its window still exists.
  if (session.visible && !session.sender.isDestroyed()) return false
  return now - getTerminalLastSeenAt(session) > maxUnseenMs
}

export function markTerminalExited(session: TerminalSession, exitCode: number, at = Date.now()): void {
  transitionTerminalActivity(session, { kind: 'exited', at, exitCode })
}

export function markTerminalFailed(
  session: TerminalSession,
  exitCode: number,
  message: string | undefined,
  at = Date.now(),
): void {
  transitionTerminalActivity(
    session,
    message ? { kind: 'failed', at, exitCode, message } : { kind: 'failed', at, exitCode },
  )
}

export function createFailedTerminalSession(input: FailedTerminalSessionInput): TerminalSession {
  const at = input.at ?? Date.now()
  const kind = input.kind ?? 'agent'
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
    ...(kind === 'agent' ? { agentState: { phase: 'failed' as const, since: at, source: 'lifecycle' as const } } : {}),
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
  // When the agent's last turn ended, if the sidecar carried it. Seeds the
  // placeholder's idle stamp so the sidebar row says when the agent finished,
  // not when the app quit — every quit-path sidecar shares one savedAt.
  lastTurnEndedAt?: number | null
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
  observedCheckout?: ObservedCheckout
  // The file ledger the sidecar persisted, newest-edited first, so a session
  // parked across an app restart still says what it changed.
  fileChanges?: Map<string, SessionFileChange>
  // The context reading the sidecar persisted, so a parked chat still says how
  // full it was.
  contextUsage?: SessionContextUsage
  // The prompts the sidecar persisted, oldest first, so the conversation peek
  // for a transcript-less runtime survives the restart along with the screen.
  peekPrompts?: SessionPrompt[]
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
// There is no pty behind it; resume disposes it and re-spawns under the same
// session id.
export function createSuspendedPlaceholderSession(input: SuspendedPlaceholderSessionInput): TerminalSession {
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
    // At rest since the turn ended when the sidecar knows it, else since the
    // sidecar was written. The quit path writes every agent's sidecar at one
    // moment, so without the turn end every rehydrated row read the same
    // "idle since the app quit" (owner, 2026-09-05).
    activity: { kind: 'idle', since: input.lastTurnEndedAt ?? input.savedAt },
    // A frozen view is at rest by construction — stamped, not guessed from
    // output timing (an in-process suspend keeps the live phase; this is the
    // restart-rehydration path, where no phase survived).
    ...((input.kind ?? 'agent') === 'agent'
      ? {
          agentState: {
            phase: 'idle' as const,
            since: input.lastTurnEndedAt ?? input.savedAt,
            source: 'lifecycle' as const,
          },
        }
      : {}),
    lastTurnEndedAt: input.lastTurnEndedAt ?? null,
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
    observedCheckout: input.observedCheckout,
    fileChanges: input.fileChanges,
    contextUsage: input.contextUsage,
    ...(input.peekPrompts?.length
      ? { peekPrompts: input.peekPrompts, lastPrompt: input.peekPrompts[input.peekPrompts.length - 1] }
      : {}),
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
  markAsRealOutput = true,
): void {
  const replayLimitBytes = getTerminalReplayLimitBytes({ ...session, lastOutputAt: at }, at)
  const chunk = trimTerminalChunkToReplayLimit(data, replayLimitBytes)
  session.outputChunks.push(chunk.data)
  session.outputChunkBytes.push(chunk.bytes)
  session.outputBytes += chunk.bytes
  session.outputLength += chunk.data.length
  if (markAsRealOutput) session.lastOutputAt = at

  if (chunk.bytes !== Buffer.byteLength(data)) session.replayTruncated = true

  while (session.outputBytes > replayLimitBytes && session.outputChunkStart < session.outputChunks.length) {
    const removed = session.outputChunks[session.outputChunkStart]
    const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0
    session.outputChunkStart += 1
    session.outputBytes -= removedBytes
    session.outputLength -= removed?.length ?? 0
    session.replayTruncated = true
  }

  if (
    session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD &&
    session.outputChunkStart > session.outputChunks.length / 2
  ) {
    session.outputChunks.splice(0, session.outputChunkStart)
    session.outputChunkBytes.splice(0, session.outputChunkStart)
    session.outputChunkStart = 0
  }
}

/**
 * How far into a cut replay to look for somewhere safe to start. A terminal
 * line is tens of bytes and an alt-screen paint opens with an escape sequence
 * almost immediately, so the resync point is always within a few hundred; the
 * window exists so that a buffer holding one pathological line — a `cat` of a
 * minified file, a progress bar drawn with carriage returns alone — loses a
 * scrap of garbage at worst instead of its entire scrollback.
 */
const REPLAY_RESYNC_WINDOW_BYTES = 8 * 1024

/**
 * `text` from the first point a terminal can safely start reading it.
 *
 * Only ever called on a replay whose head was CUT (see `replayTruncated`), and
 * that cut is the whole problem: chunks are pty read boundaries, not escape
 * sequence boundaries, so dropping the oldest ones routinely leaves the window
 * starting in the middle of one. xterm has no introducer to match, so it prints
 * the remainder as text, and a chat reopened after a busy run greets its owner
 * with `38;2;139;139;140;48;2;34;34;37m` across the top of an otherwise black
 * screen (observed 2026-09-12, a Codex chat switched away from and back).
 *
 * Two resync points, whichever comes first:
 *   - an ESC, which BEGINS a sequence, so everything from there parses;
 *   - the byte after a newline, which no CSI sequence can span.
 * What sits before it is the tail of a sequence nobody can interpret, plus at
 * most a line of text that was already losing its colour with it.
 */
export function resyncTerminalReplayHead(text: string): string {
  // Already at a sequence boundary — the common case for a cut that happened to
  // land on one, and nothing to do.
  if (text.charCodeAt(0) === 0x1b) return text
  const window = Math.min(text.length, REPLAY_RESYNC_WINDOW_BYTES)
  for (let index = 0; index < window; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x1b) return text.slice(index)
    if (code === 0x0a) return text.slice(index + 1)
  }
  // Nothing to resync to within the window. Whatever is at the head is plain
  // enough to print, and gutting the scrollback to be sure would cost more than
  // the garbage it saves.
  return text
}

export function materializeTerminalReplay(session: TerminalSession): string {
  compactTerminalReplayToLimit(session)
  const replay = session.outputChunks.slice(session.outputChunkStart).join('')
  // A buffer that has never been cut is replayed byte for byte: its head is
  // where the CLI itself started, and resyncing would eat the banner.
  return session.replayTruncated ? resyncTerminalReplayHead(replay) : replay
}

// What one session's ledger is allowed to cost. It rides every snapshot
// broadcast to every window, so it cannot be unbounded: a run that touches
// thousands of files would turn each IPC send into a large one. Two bounds,
// because either alone is a lie — a path is capped at 4096 characters, so five
// hundred of them is megabytes, while five hundred ordinary paths is tens of
// kilobytes. Past either bound the LEAST recently edited entry is dropped: the
// list is read newest-first, so what falls off the end is what nobody was
// looking at.
export const MAX_SESSION_FILE_CHANGES = 500
export const MAX_SESSION_FILE_CHANGE_PATH_CHARS = 64 * 1024

/**
 * Fold one reported edit into the session's ledger. Counts ACCUMULATE (a line
 * edited twice counts twice — see SessionFileChange), `edits` counts the tool
 * calls, and the entry is re-inserted so the map's last key is always the most
 * recent edit.
 *
 * Returns whether anything changed, which is what decides whether the caller
 * broadcasts. An edit always changes something (`edits` at minimum), so this is
 * true whenever a well-formed change arrives — the return value exists so the
 * call site reads like the other observations, and so a future no-op case has
 * somewhere to live.
 */
/**
 * How many recent folds the duplicate ring remembers. A duplicate arrives
 * within milliseconds of its twin (two hook processes on one tool call), so the
 * window only has to outlive the burst of frames one call produces — a Codex
 * multi-file patch is the widest, at one frame per file. 128 covers that many
 * times over and costs a few KB.
 */
/** One fold the ring remembers: when, and which tool call (null for an id-less reporter). */
export type FoldedFileChange = { at: number; toolUseId: string | null }

export const MAX_FOLDED_FILE_CHANGE_KEYS = 128

/**
 * How far apart two IDENTICAL file changes with no tool-call id may be and
 * still be read as one edit reported twice. Cursor's `afterFileEdit` is the
 * only reporter shape with no id; a second registration's copy of a frame
 * arrives in the same instant, while a person's agent genuinely re-making the
 * identical edit to the identical file is seconds of model output away.
 */
export const DUPLICATE_FILE_CHANGE_WINDOW_MS = 3000

/**
 * Whether this file change is one this session has NOT already folded — true
 * for a first sighting (which it records), false for a duplicate.
 *
 * Two keys, because not every reporter has an id to give:
 *
 *   - With a `toolUseId`, the key is `(toolUseId, path)`. The id is the CLI's,
 *     so both registrations of the reporter forward the SAME one for one tool
 *     call, and a genuinely second edit is a second call with a different id.
 *     The PATH is in the key because one call legitimately reports several
 *     files — a MultiEdit across files, a Codex multi-file patch — as N frames
 *     under one id, and every one of them must fold. No time window on this
 *     key: a duplicate registration's copy is a duplicate however late it
 *     lands, and a reporter RETRYING a socket write that failed is safe either
 *     way — the failed write never reached this ring, so the retry is the
 *     first arrival and folds; a retry of one that did land is caught.
 *   - Without one, the key is the change's whole shape — path, both counts and
 *     the edit regions — and it only counts as a duplicate inside
 *     DUPLICATE_FILE_CHANGE_WINDOW_MS of the fold it matches. A second
 *     identical edit that fast is a second registration; the same edit made
 *     again ten seconds later is a real one, and re-folds (and re-stamps the
 *     key, so a third arrival is measured from the second).
 *
 * Claude Code's parallel edits share no id BETWEEN calls — each tool call has
 * its own — so two concurrent edits to different files both fold on either key.
 */
export function noteFoldedFileChange(
  session: TerminalSession,
  change: { path: string; additions: number; deletions: number; edits?: unknown },
  toolUseId: string | undefined,
  at: number,
): boolean {
  const ring = (session.foldedFileChanges ??= new Map<string, FoldedFileChange>())
  // BOTH keys, always. The two registrations of one edit need not agree on
  // whether they carry an id: a stale plugin copy left over from before the
  // reporter forwarded tool-call ids fires an id-less frame beside the current
  // reporter's id-bearing one (seen live, 2026-09-09), and two keys that never
  // meet fold the edit twice. So the shape key is checked and stamped on every
  // frame, and the id key in addition when there is one. The shape match only
  // counts when at least one of the two frames is id-less: two frames with two
  // DIFFERENT ids are two tool calls by the CLI's own word, however alike.
  const shapeKey = `shape\u0000${change.path}\u0000${change.additions}\u0000${change.deletions}\u0000${
    change.edits ? JSON.stringify(change.edits) : ''
  }`
  const idKey = toolUseId ? `id\u0000${toolUseId}\u0000${change.path}` : null
  const byShape = ring.get(shapeKey)
  const shapeSaysDuplicate =
    byShape !== undefined &&
    Math.abs(at - byShape.at) <= DUPLICATE_FILE_CHANGE_WINDOW_MS &&
    (!toolUseId || !byShape.toolUseId || byShape.toolUseId === toolUseId)
  if ((idKey !== null && ring.has(idKey)) || shapeSaysDuplicate) return false
  if (byShape !== undefined) ring.delete(shapeKey)
  const entry: FoldedFileChange = { at, toolUseId: toolUseId ?? null }
  ring.set(shapeKey, entry)
  if (idKey !== null) ring.set(idKey, entry)
  while (ring.size > MAX_FOLDED_FILE_CHANGE_KEYS) {
    const oldest = ring.keys().next().value
    if (oldest === undefined) break
    ring.delete(oldest)
  }
  return true
}

export function recordSessionFileChange(
  session: TerminalSession,
  change: { path: string; additions: number; deletions: number },
  at: number,
): boolean {
  const ledger = (session.fileChanges ??= new Map<string, SessionFileChange>())
  const existing = ledger.get(change.path)
  // Delete before set so the entry moves to the end of the insertion order:
  // that order is the recency order the snapshot reads back. Only when this
  // observation is actually the newest one for the file — a late-arriving
  // earlier edit adds its lines where the file already sits rather than
  // promoting it past files edited after it. (`set` on an existing key keeps
  // its position.)
  if (existing && at >= existing.lastEditedAt) ledger.delete(change.path)
  ledger.set(change.path, {
    path: change.path,
    additions: (existing?.additions ?? 0) + change.additions,
    deletions: (existing?.deletions ?? 0) + change.deletions,
    edits: (existing?.edits ?? 0) + 1,
    // A frame that arrives out of order must not move the ledger backwards.
    lastEditedAt: Math.max(existing?.lastEditedAt ?? 0, at),
  })
  evictOldestFileChangesPastBudget(ledger)
  return true
}

/** Drop least-recently-edited entries until the ledger is inside both bounds. */
function evictOldestFileChangesPastBudget(ledger: Map<string, SessionFileChange>): void {
  let pathChars = 0
  for (const path of ledger.keys()) pathChars += path.length
  while (ledger.size > MAX_SESSION_FILE_CHANGES || pathChars > MAX_SESSION_FILE_CHANGE_PATH_CHARS) {
    const oldest = ledger.keys().next().value
    if (oldest === undefined) break
    // Never evict the only entry: the newest edit is the one thing the ledger
    // must always be able to state, however long its path.
    if (ledger.size === 1) break
    ledger.delete(oldest)
    pathChars -= oldest.length
  }
}

/**
 * Where the snapshot's `pullRequests` come from (epic `pull-request-marks`,
 * decision 10). The record that owns them (`pull-request-record.ts`) is wired in
 * by the app rather than imported here: this module knows a session, not a
 * checkout's GitHub history, and a session snapshot must stay buildable in a
 * test with no store behind it. Unset — a plain terminal, a test, main before
 * the record exists — every snapshot simply carries an empty list.
 */
export type SessionPullRequestReader = (session: TerminalSession) => BranchPullRequest[]

let readSessionPullRequests: SessionPullRequestReader | null = null

export function setSessionPullRequestReader(reader: SessionPullRequestReader | null): void {
  readSessionPullRequests = reader
}

function listSessionPullRequests(session: TerminalSession): BranchPullRequest[] {
  if (!readSessionPullRequests) return []
  try {
    return readSessionPullRequests(session)
  } catch {
    // A snapshot is built on every broadcast; a store that threw must cost a
    // list, never a session.
    return []
  }
}

/** The ledger as the renderer reads it: newest-edited first. */
export function listSessionFileChanges(session: TerminalSession): SessionFileChange[] {
  if (!session.fileChanges || session.fileChanges.size === 0) return []
  return [...session.fileChanges.values()].reverse()
}

/**
 * Rebuild a ledger from a persisted (newest-first) list — the snapshot sidecar,
 * which is a file on disk and therefore untrusted input like any other. Shape
 * is checked here; the entries are re-inserted oldest-first so the recency
 * order survives the round trip.
 */
export function parseSessionFileChanges(raw: unknown): Map<string, SessionFileChange> | undefined {
  if (!Array.isArray(raw)) return undefined
  const ledger = new Map<string, SessionFileChange>()
  const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  // Read the head of the list — it is newest-first — rather than reversing the
  // whole thing: a corrupt file naming a million entries must not buy itself a
  // million iterations on the main thread during rehydration. Inserted in
  // reverse so the map's insertion order comes back as the recency order.
  const head = raw.slice(0, MAX_SESSION_FILE_CHANGES).reverse()
  for (const entry of head) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<SessionFileChange>
    // The same rules the socket applies (agent-state.ts): a sidecar is a file on
    // disk, no more trusted than a reporter frame, and this path is broadcast to
    // every window and keyed on.
    if (typeof candidate.path !== 'string' || !isValidFileChangePath(candidate.path)) continue
    if (!isCount(candidate.additions) || !isCount(candidate.deletions) || !isCount(candidate.edits)) continue
    if (!isCount(candidate.lastEditedAt)) continue
    ledger.delete(candidate.path)
    ledger.set(candidate.path, {
      path: candidate.path,
      additions: Math.min(Math.floor(candidate.additions), MAX_FILE_CHANGE_COUNT),
      deletions: Math.min(Math.floor(candidate.deletions), MAX_FILE_CHANGE_COUNT),
      edits: Math.min(Math.floor(candidate.edits), MAX_FILE_CHANGE_COUNT),
      lastEditedAt: Math.floor(candidate.lastEditedAt),
    })
    evictOldestFileChangesPastBudget(ledger)
  }
  return ledger.size > 0 ? ledger : undefined
}

/**
 * Prompts read back from a snapshot sidecar — a file on disk, and therefore
 * untrusted input, however this app wrote it. Shape and bounds are re-applied
 * here rather than assumed: the caps are the live path's own
 * ({@link MAX_LIVE_PEEK_PROMPTS} entries, MAX_AGENT_PROMPT_LENGTH each), so a
 * hand-edited or corrupt file can put nothing on a card that the hook itself
 * could not have.
 */
export function parseSessionPrompts(raw: unknown): SessionPrompt[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const prompts: SessionPrompt[] = []
  // The head, not the whole list: a file naming a million prompts must not buy
  // itself a million iterations on the main thread during rehydration. The list
  // is oldest-first and the first entry is the one the card quotes in full, so
  // the head is also the half worth keeping.
  for (const entry of raw.slice(0, MAX_LIVE_PEEK_PROMPTS)) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<SessionPrompt>
    if (typeof candidate.text !== 'string') continue
    const text = candidate.text.slice(0, MAX_AGENT_PROMPT_LENGTH)
    if (!text.trim()) continue
    if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at) || candidate.at < 0) continue
    prompts.push({ text, at: Math.floor(candidate.at) })
  }
  return prompts.length > 0 ? prompts : undefined
}

/**
 * The session's own status line, as its last reading left it. Everything except
 * `at` is optional for the same reason the frame's fields are: the CLI reports
 * what it knows.
 */
export type SessionStatusLine = {
  usedPercentage?: number
  contextWindowSize?: number
  totalCostUsd?: number
  linesAdded?: number
  linesRemoved?: number
  model?: string
  sessionName?: string
  // When the reading that produced this state arrived. Also the ordering guard:
  // a status line refreshes several times a turn and its frames can be
  // delivered out of order.
  at: number
}

/**
 * Fold one status-line reading into the session.
 *
 * Returns whether the SNAPSHOT changed — that is, whether the whole-percent
 * context usage moved. It is the only part of this that a window renders today,
 * and the status line refreshes after every assistant message: broadcasting on
 * a cost that ticked by a thousandth of a cent would be a broadcast per turn
 * per session for nothing anyone can see.
 *
 * The reading MERGES rather than replaces. A payload whose `used_percentage` is
 * null (before the first API call, and again right after a /compact) arrives
 * with the field simply absent, and must not take the cost, the model or the
 * last known percentage with it.
 *
 * `contextUsage.at` is the moment the percentage LAST MOVED, not the moment of
 * the last reading, so that what is held is exactly what was last broadcast —
 * a timestamp that advanced silently on every refresh would drift away from
 * every window and from the sidecar written off it.
 *
 * Unlike the file ledger beside it, a reading is NOT order-independent: it is a
 * level, not a sum, so a late-arriving older one is dropped rather than folded.
 */
export function recordSessionStatusLine(
  session: TerminalSession,
  reading: AgentStateFrameStatusLine,
  at: number,
): boolean {
  const previous = session.statusLine
  // Out of order: a status-line process is spawned per refresh and they can
  // finish in any order. An older reading carries older facts, and the next
  // refresh repairs anything this drops.
  if (previous && previous.at > at) return false
  session.statusLine = { ...previous, ...reading, at }

  const usedPercentage = reading.usedPercentage
  if (usedPercentage === undefined) return false
  if (session.contextUsage?.usedPercentage === usedPercentage) return false
  session.contextUsage = { usedPercentage, at }
  return true
}

/**
 * Read a persisted context reading back off the snapshot sidecar. A file on
 * disk is untrusted input like a reporter frame, so this applies the same rules
 * the socket does (whole percent, 0..100, a real timestamp).
 */
export function parseSessionContextUsage(raw: unknown, now = Date.now()): SessionContextUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as Partial<SessionContextUsage>
  const { usedPercentage, at } = candidate
  if (typeof usedPercentage !== 'number' || !Number.isFinite(usedPercentage)) return undefined
  if (usedPercentage < 0 || usedPercentage > 100) return undefined
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return undefined
  // Clamped to arrival, exactly as a reporter frame's `ts` is: a far-future
  // time on disk would be re-written to the sidecar on the next suspend and
  // ride into every window from there.
  return { usedPercentage: Math.round(usedPercentage), at: Math.min(Math.floor(at), now) }
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
    executionMode: session.executionMode,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    observedCheckout: session.observedCheckout,
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
    // What this agent has edited, newest first, and how many subagents it still
    // owns. Both are hook truth; a session with no hooks reports an empty
    // ledger and zero, never absence.
    fileChanges: listSessionFileChanges(session),
    // Where this conversation's work went, newest first. Empty until its
    // checkout resolves and GitHub has actually been asked — the app draws a
    // mark only for a pull request it definitely has.
    pullRequests: listSessionPullRequests(session),
    activeSubagents: session.backgroundWork ?? 0,
    // The status-line forwarder's reading, or null for a session whose CLI has
    // no status line and for one that has not made an API call yet.
    contextUsage: session.contextUsage ?? null,
    lastTurnEndedAt: session.lastTurnEndedAt ?? null,
    exitedAt: session.exitedAt,
    outputBufferLength: session.outputLength,
    retainedOutputBytes: session.outputBytes,
    historyTier: getTerminalHistoryTier(session),
    replayLimitBytes: getTerminalReplayLimitBytes(session),
  }
}

function compactTerminalReplayToLimit(session: TerminalSession, now = Date.now()): void {
  const replayLimitBytes = getTerminalReplayLimitBytes(session, now)
  while (session.outputBytes > replayLimitBytes && session.outputChunks.length - session.outputChunkStart > 1) {
    const removed = session.outputChunks[session.outputChunkStart]
    const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0
    session.outputChunkStart += 1
    session.outputBytes -= removedBytes
    session.outputLength -= removed?.length ?? 0
    session.replayTruncated = true
  }

  if (session.outputBytes > replayLimitBytes && session.outputChunks.length - session.outputChunkStart === 1) {
    const index = session.outputChunkStart
    const chunk = session.outputChunks[index] ?? ''
    const trimmed = trimTerminalChunkToReplayLimit(chunk, replayLimitBytes)
    session.outputChunks[index] = trimmed.data
    session.outputChunkBytes[index] = trimmed.bytes
    session.outputBytes = trimmed.bytes
    session.outputLength = trimmed.data.length
    session.replayTruncated = true
  }

  if (
    session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD &&
    session.outputChunkStart > session.outputChunks.length / 2
  ) {
    session.outputChunks.splice(0, session.outputChunkStart)
    session.outputChunkBytes.splice(0, session.outputChunkStart)
    session.outputChunkStart = 0
  }
}

function trimTerminalChunkToReplayLimit(
  data: string,
  replayLimitBytes = TERMINAL_STANDARD_REPLAY_BYTES,
): { data: string; bytes: number } {
  const bytes = Buffer.byteLength(data)
  if (bytes <= replayLimitBytes) return { data, bytes }

  const buffer = Buffer.from(data)
  // Past any continuation byte the cut landed on: `toString('utf8')` renders a
  // half-eaten codepoint as U+FFFD, and the head of a replay is the one place
  // that shows. Bounded by 3 — the longest UTF-8 tail there is.
  let offset = bytes - replayLimitBytes
  while (offset < bytes && (buffer[offset] & 0xc0) === 0x80) offset += 1
  const trimmed = buffer.subarray(offset).toString('utf8')

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

/**
 * Event sink for sessions spawned with no window (a headless launch). Every
 * outbound send is guarded on
 * `isDestroyed()`, so a headless session simply emits nothing until a window
 * attaches — the reattach path (`spawnTerminalFromIpc` existing-session
 * branch) then adopts the real WebContents and replays scrollback.
 */
export function createHeadlessTerminalSender(): WebContents {
  return createNoopWebContents()
}
