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

export function isSessionWorking(
  session: TerminalSessionSnapshot | null | undefined
): boolean {
  return session?.activity.kind === 'working'
}

export function isSessionFailed(
  session: TerminalSessionSnapshot | null | undefined
): boolean {
  return session?.activity.kind === 'failed'
}

export function findSession(
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
    if (session.kind !== 'agent') continue
    if (session.workspaceId !== workspaceId) continue
    const activity = session.activity
    if (activity.kind === 'working') {
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

// True when any agent terminal in the workspace reports an authoritative
// `awaiting_input` phase from its lifecycle hooks — the agent is blocked on a
// prompt/permission and needs the user. This is the hook-based, CLI-agnostic
// companion to the SprintEngine `needs_input` runtime signal: additive to it, and
// the reason an awaiting agent surfaces as `needs-input` rather than `idle` (its
// bridged `activity` is idle while it waits).
//
// Gated on `processAlive`: `onExit` clears `agentState`, but a dead session is
// still snapshotted, and only a live agent can actually be waiting on the user —
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

export function findExecutionTerminalSession(
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

export type TabRecencySource = 'input' | 'persisted' | 'exited'

export type TabRecencyDisplay = {
  at: number
  source: TabRecencySource
}

// Per-tab recency mirrors the sidebar: "last typed into this terminal", from
// lastInputAt, so revealing a tab never reads as "now". See deriveWorkspaceLastInputAt.
export function pickTerminalTabRecency(
  session: TerminalSessionSnapshot | null | undefined
): TabRecencyDisplay | null {
  if (!session) return null
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
