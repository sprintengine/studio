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
  | { kind: 'idle-recency'; lastOutputAt: number }
  | { kind: 'quiet' }

export type WorkspaceDisplayActivity = 'needs-input' | 'working' | 'failed' | 'idle'

export function deriveWorkspaceLastOutputAt(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[],
  persistedLastOutputAt?: number | null
): number | null {
  let max: number | null =
    typeof persistedLastOutputAt === 'number' ? persistedLastOutputAt : null
  for (const session of sessions) {
    if (session.workspaceId !== workspaceId) continue
    if (typeof session.lastOutputAt !== 'number') continue
    if (max === null || session.lastOutputAt > max) max = session.lastOutputAt
  }
  return max
}

export function deriveWorkspaceTerminalActivity(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[],
  persistedLastOutputAt?: number | null
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

  const lastOutputAt = deriveWorkspaceLastOutputAt(workspaceId, sessions, persistedLastOutputAt)
  if (lastOutputAt !== null) return { kind: 'idle-recency', lastOutputAt }
  return { kind: 'quiet' }
}

export function deriveWorkspaceDisplayActivity(
  workspaceId: string,
  sessions: TerminalSessionSnapshot[],
  needsInput: boolean
): WorkspaceDisplayActivity {
  if (needsInput) return 'needs-input'
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

export type TabRecencySource = 'output' | 'persisted' | 'exited'

export type TabRecencyDisplay = {
  at: number
  source: TabRecencySource
}

export function pickTerminalTabRecency(
  session: TerminalSessionSnapshot | null | undefined
): TabRecencyDisplay | null {
  if (!session) return null
  if (typeof session.lastOutputAt === 'number') {
    return { at: session.lastOutputAt, source: 'output' }
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
  if (session && typeof session.lastOutputAt === 'number') {
    return { at: session.lastOutputAt, source: 'output' }
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
  if (source === 'output') return 'Last output'
  if (source === 'persisted') return 'Last terminal activity'
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
