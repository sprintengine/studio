import { useMemo, useSyncExternalStore } from 'react'
import {
  getLiveTerminalSessionsSnapshot,
  getTerminalSessionsSignature,
  getTerminalSessionsSnapshot,
  refreshTerminalSessions,
  subscribeLiveTerminalSessions,
  subscribeLiveTerminalSessionSnapshots,
  subscribeTerminalSessions,
} from './terminalSessionsStore'

export {
  getLiveTerminalSessionsSnapshot,
  getTerminalSessionsSignature,
  refreshTerminalSessions,
  subscribeLiveTerminalSessionSnapshots,
}

export type UseTerminalSessionsOptions = {
  // Opt out of signature dedup and apply every broadcast. Use for surfaces that
  // render high-frequency fields the signature deliberately omits — notably the
  // Diagnostics terminal table (retainedOutputBytes, visible, lastOutputAt).
  // Default (false) suppresses no-op re-renders for the common case.
  live?: boolean
}

export function useTerminalSessions(options?: UseTerminalSessionsOptions): TerminalSessionSnapshot[] {
  const live = options?.live ?? false
  return useSyncExternalStore(
    live ? subscribeLiveTerminalSessions : subscribeTerminalSessions,
    live ? getLiveTerminalSessionsSnapshot : getTerminalSessionsSnapshot,
    live ? getLiveTerminalSessionsSnapshot : getTerminalSessionsSnapshot,
  )
}

export function isLiveTerminal(
  session: TerminalSessionSnapshot | null | undefined
): boolean {
  return Boolean(session?.processAlive)
}

/**
 * A turn in flight, in a process that is still there to run it.
 *
 * Both halves are load-bearing. `activity` is a stamp, not a subscription: a
 * session that is suspended (or killed) mid-turn keeps whatever it last said,
 * and main has no reason to revisit it. So "working" without `processAlive` is
 * a claim about a process that no longer exists — the same shape of lie that
 * `workspaceTerminalAwaitingInput` has always gated on, and for the same
 * reason: it must not outlive the pty and keep the sidebar lit.
 */
export function isSessionWorking(
  session: TerminalSessionSnapshot | null | undefined
): boolean {
  return Boolean(session?.processAlive) && session?.activity.kind === 'working'
}

export function isSessionFailed(
  session: TerminalSessionSnapshot | null | undefined
): boolean {
  return session?.activity.kind === 'failed'
}

function findSession(
  sessions: TerminalSessionSnapshot[],
  predicate: (session: TerminalSessionSnapshot) => boolean
): TerminalSessionSnapshot | null {
  return sessions.find(predicate) ?? null
}

export function findLiveSession(
  sessions: TerminalSessionSnapshot[],
  predicate: (session: TerminalSessionSnapshot) => boolean
): TerminalSessionSnapshot | null {
  return sessions.find((session) => session.processAlive && predicate(session)) ?? null
}

export function useSession(
  predicate: (session: TerminalSessionSnapshot) => boolean
): TerminalSessionSnapshot | null {
  const sessions = useTerminalSessions()
  return useMemo(() => findSession(sessions, predicate), [sessions, predicate])
}

export type WorkspaceTerminalActivity =
  | { kind: 'working'; since: number }
  | { kind: 'failed'; at: number; exitCode: number; message?: string }
  | { kind: 'idle-recency'; lastInputAt: number }
  | { kind: 'quiet' }

export type WorkspaceDisplayActivity = 'needs-input' | 'working' | 'failed' | 'idle'

// Workspace recency is "when the user last typed into one of its terminals", NOT
// when a terminal last produced output. Output-driven recency made merely opening
// a workspace look live: re-attaching its terminals replays scrollback and the
// alt-screen TUI repaints, and that incoming data bumped lastOutputAt to "now".
// Keying off lastInputAt (genuine keystrokes/paste — see recordTerminalInput in
// the main process) means revealing a workspace never moves its timestamp; only
// real interaction does. The live "working" status is tracked separately via
// session.activity, so an actively-working agent still surfaces as live.
export function deriveWorkspaceLastInputAt(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[],
  persistedLastInputAt?: number | null
): number | null {
  let max: number | null =
    typeof persistedLastInputAt === 'number' ? persistedLastInputAt : null
  for (const session of sessions) {
    if (session.workspaceId !== workspaceId) continue
    if (typeof session.lastInputAt !== 'number') continue
    if (max === null || session.lastInputAt > max) max = session.lastInputAt
  }
  return max
}

export function deriveWorkspaceTerminalActivity(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[],
  persistedLastInputAt?: number | null
): WorkspaceTerminalActivity {
  let workingSince: number | null = null
  let failedAt: number | null = null
  let failedDetail: { exitCode: number; message?: string } | null = null

  for (const session of sessions) {
    if (session.workspaceId !== workspaceId) continue
    const activity = session.activity
    if (activity.kind === 'working') {
      // Live processes only (`isSessionWorking`). A chat whose last agent was
      // paused mid-turn would otherwise read as working for as long as the
      // frozen session sits in the list: bold row, working dots, no idle
      // clock — the sidebar claiming an agent that is not there.
      if (!isSessionWorking(session)) continue
      if (workingSince === null || activity.since < workingSince) workingSince = activity.since
    } else if (activity.kind === 'failed') {
      if (failedAt === null || activity.at > failedAt) {
        failedAt = activity.at
        failedDetail = { exitCode: activity.exitCode, message: activity.message }
      }
    }
  }

  if (workingSince !== null) return { kind: 'working', since: workingSince }
  if (failedAt !== null && failedDetail !== null) {
    return { kind: 'failed', at: failedAt, exitCode: failedDetail.exitCode, message: failedDetail.message }
  }

  const lastInputAt = deriveWorkspaceLastInputAt(workspaceId, sessions, persistedLastInputAt)
  if (lastInputAt !== null) return { kind: 'idle-recency', lastInputAt }
  return { kind: 'quiet' }
}

// When every terminal is at rest, recency starts from the moment the workspace
// actually became idle: the newest idle transition across its sessions. This is
// separate from last-input recency, which remains the ordering signal.
// When the workspace went quiet, for the sidebar row's idle time. Per session
// the hook-reported turn end wins (owner, 2026-09-05): a suspended or exited
// session's activity stamp says when the process died — the reaper's sweep, or
// the app quitting, which stamps every session at once — not when the agent
// finished. A failure keeps its own stamp. With no session at all (a parked
// chat after a restart, before its sidecar is rehydrated) the persisted turn
// end and last-typed stamps stand in, whichever is later.
export function deriveWorkspaceIdleSince(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[],
  persistedLastInputAt?: number | null,
  persistedTurnEndedAt?: number | null
): number | null {
  let idleSince: number | null = null
  for (const session of sessions) {
    if (session.workspaceId !== workspaceId) continue
    const at = sessionIdleSince(session)
    if (at !== null && (idleSince === null || at > idleSince)) idleSince = at
  }
  if (idleSince !== null) return idleSince
  const lastInputAt = deriveWorkspaceLastInputAt(workspaceId, sessions, persistedLastInputAt)
  if (typeof persistedTurnEndedAt !== 'number') return lastInputAt
  return lastInputAt === null ? persistedTurnEndedAt : Math.max(lastInputAt, persistedTurnEndedAt)
}

// True when any agent terminal in the workspace reports an authoritative
// `awaiting_input` phase from its lifecycle hooks — the agent is blocked on a
// prompt/permission and needs the user. This is the hook-based, CLI-agnostic
// companion to the SprintEngine `needs_input` runtime signal: additive to it, and
// the reason an awaiting agent surfaces as `needs-input` rather than `idle` (its
// bridged `activity` is idle while it waits).
//
// Gated on `processAlive`: `onExit` stamps the phase `exited`, but a dead
// session is still snapshotted, and only a live agent can actually be waiting on the user —
// a stale `awaiting_input` from an exited/crashed agent must not keep the glyph
// lit.
export function workspaceTerminalAwaitingInput(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[]
): boolean {
  return sessions.some(
    (session) =>
      session.kind === 'agent'
      && session.workspaceId === workspaceId
      && session.processAlive
      && session.agentState?.phase === 'awaiting_input'
  )
}

// A phase the CLI's own hooks have reported as a turn genuinely in flight.
//
// 'starting' is deliberately NOT one of them, even though it derives to
// `working`: every agent session is BORN in it (`createInitialAgentState`), and
// it is a lifecycle stamp rather than a hook's word — `source` says which. A
// duration keyed off it starts counting the moment a suspended terminal is
// resumed, before the person has asked for anything.
function isHookReportedTurnInFlight(session: TerminalSessionSnapshot): boolean {
  const state = session.agentState
  if (!state || state.source !== 'hook') return false
  return state.phase === 'thinking' || state.phase === 'tool_use'
}

/**
 * When the turn currently in flight began — the clock behind the sidebar row's
 * "working for 4m" — or null when nothing in the workspace is mid-turn.
 *
 * Deliberately narrower than `deriveWorkspaceTerminalActivity`'s `working`.
 * That one answers "is this row live", and is right to include a starting
 * agent or a noisy plain shell: a dot claims nothing about how long. A
 * duration does, so it is only claimed where hooks have said a turn is
 * running ([[agent-state-hooks-only]] — the pane and the lifecycle stamp are
 * not evidence of a turn).
 *
 * The start is the later of two facts, which is right in every case:
 * - `activity.since` marks the turn, not the step: the runtime pins it across
 *   thinking↔tool_use churn rather than bumping it per frame.
 * - but it is SEEDED at process start (`createInitialTerminalActivity`), and
 *   that seed survives into the first real turn of a freshly resumed session,
 *   because the same pinning declines to re-stamp an already-working session.
 *   `lastPrompt.at` — the UserPromptSubmit hook, i.e. when the person actually
 *   asked — overtakes the stale seed there.
 * Taking the later of the two also means a turn with no prompt behind it (an
 * automation, a resumed continuation) still reads from `activity.since`, and a
 * prompt left over from a previous turn can never pull the clock backwards.
 */
export function deriveWorkspaceWorkingSince(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[]
): number | null {
  let since: number | null = null
  for (const session of sessions) {
    if (session.workspaceId !== workspaceId) continue
    const startedTurnAt = sessionWorkingSince(session)
    if (startedTurnAt === null) continue
    // The longest-running turn holds the row: one workspace, one clock.
    if (since === null || startedTurnAt < since) since = startedTurnAt
  }
  return since
}

/**
 * When THIS session's turn in flight began — the clock behind a sidebar
 * terminal line's "working for 4m" (sidebar-lists-every-terminal) — or null
 * when it is not mid-turn. The per-session half of
 * {@link deriveWorkspaceWorkingSince}: the workspace's clock is the fold of
 * these, so a row and its lines can never disagree on who is working.
 */
function sessionWorkingSince(session: TerminalSessionSnapshot): number | null {
  const activity = session.activity
  // `isSessionWorking` is the gate (a dead process runs no turn); the kind
  // check beside it is what narrows `activity` to the variant with a `since`.
  if (activity.kind !== 'working' || !isSessionWorking(session)) return null
  if (!isHookReportedTurnInFlight(session)) return null
  const promptAt = typeof session.lastPrompt?.at === 'number' ? session.lastPrompt.at : 0
  return Math.max(activity.since, promptAt)
}

/**
 * When THIS session last stopped doing something — its last turn end, its
 * failure, its idle or exit stamp — or null when nothing is known. The
 * per-session half of {@link deriveWorkspaceIdleSince}, which folds these and
 * then falls back to the workspace's persisted stamps.
 */
function sessionIdleSince(session: TerminalSessionSnapshot): number | null {
  const activity = session.activity
  return activity.kind === 'failed'
    ? activity.at
    : typeof session.lastTurnEndedAt === 'number'
      ? session.lastTurnEndedAt
      : activity.kind === 'idle'
        ? activity.since
        : activity.kind === 'exited'
          ? activity.at
          : null
}

export type SessionRecency = {
  /** The turn in flight began here; null when the session is not mid-turn. */
  workingSince: number | null
  /** A live agent blocked on a prompt or permission (hook-authoritative). */
  needsInput: boolean
  /** The last moment it stopped; null when nothing is known yet. */
  idleSince: number | null
}

/** One terminal's recency, for the sidebar line that describes it alone. */
export function sessionRecencyOf(session: TerminalSessionSnapshot): SessionRecency {
  return {
    workingSince: sessionWorkingSince(session),
    needsInput: session.kind === 'agent' && session.processAlive && session.agentState?.phase === 'awaiting_input',
    idleSince: sessionIdleSince(session),
  }
}

export function deriveWorkspaceDisplayActivity(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[],
  needsInput: boolean
): WorkspaceDisplayActivity {
  if (needsInput || workspaceTerminalAwaitingInput(workspaceId, sessions)) return 'needs-input'
  const terminalActivity = deriveWorkspaceTerminalActivity(workspaceId, sessions)
  if (terminalActivity.kind === 'working') return 'working'
  if (terminalActivity.kind === 'failed') return 'failed'
  return 'idle'
}

function findExecutionTerminalSession(
  sessions: TerminalSessionSnapshot[],
  workspaceId: string,
  executionId: string | null | undefined
): TerminalSessionSnapshot | null {
  if (!executionId) return null
  return (
    sessions.find(
      (session) =>
        session.kind === 'agent' &&
        session.workspaceId === workspaceId &&
        session.agentSession?.executionId === executionId
    ) ?? null
  )
}

export type TabRecencySource = 'idle' | 'input' | 'persisted' | 'exited'

export type TabRecencyDisplay = {
  at: number
  source: TabRecencySource
}

// A resting tab counts from its idle transition. Exited sessions retain the
// historical last-input fallback because they no longer have a live idle phase.
export function pickTerminalTabRecency(
  session: TerminalSessionSnapshot | null | undefined
): TabRecencyDisplay | null {
  if (!session) return null
  if (session.activity.kind === 'idle') {
    return { at: session.activity.since, source: 'idle' }
  }
  if (typeof session.lastInputAt === 'number') {
    return { at: session.lastInputAt, source: 'input' }
  }
  if (typeof session.exitedAt === 'number') {
    return { at: session.exitedAt, source: 'exited' }
  }
  return null
}

export function pickAgentTabRecency(
  session: TerminalSessionSnapshot | null | undefined,
  persistedWorkspaceRecency: number | null | undefined,
  cliLastExitedAt: number | null | undefined
): TabRecencyDisplay | null {
  if (session?.activity.kind === 'idle') {
    return { at: session.activity.since, source: 'idle' }
  }
  if (session && typeof session.lastInputAt === 'number') {
    return { at: session.lastInputAt, source: 'input' }
  }
  if (typeof persistedWorkspaceRecency === 'number') {
    return { at: persistedWorkspaceRecency, source: 'persisted' }
  }
  if (session && typeof session.exitedAt === 'number') {
    return { at: session.exitedAt, source: 'exited' }
  }
  if (typeof cliLastExitedAt === 'number') {
    return { at: cliLastExitedAt, source: 'exited' }
  }
  return null
}

export function tabRecencyLabel(source: TabRecencySource): string {
  if (source === 'idle') return 'Idle'
  if (source === 'input') return 'Last typed'
  if (source === 'persisted') return 'Last activity'
  return 'Exited'
}

export type ExecutionTerminalState =
  | { kind: 'missing' }
  | { kind: 'running'; sessionId: string; agentId: string }
  | { kind: 'exited'; sessionId: string; agentId: string }

export function describeExecutionTerminal(
  sessions: TerminalSessionSnapshot[],
  workspaceId: string,
  executionId: string | null | undefined
): ExecutionTerminalState {
  const session = findExecutionTerminalSession(sessions, workspaceId, executionId)
  if (!session) return { kind: 'missing' }
  const agentId =
    session.agentId ?? session.agentSession?.executionId ?? executionId ?? session.sessionId
  return isLiveTerminal(session)
    ? { kind: 'running', sessionId: session.sessionId, agentId }
    : { kind: 'exited', sessionId: session.sessionId, agentId }
}
