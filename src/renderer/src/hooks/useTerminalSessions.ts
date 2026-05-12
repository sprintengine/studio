import { useEffect, useState } from 'react'

export function useTerminalSessions(): TerminalSessionSnapshot[] {
  const [sessions, setSessions] = useState<TerminalSessionSnapshot[]>([])

  useEffect(() => {
    let disposed = false

    void window.api
      .terminalList()
      .then((next) => {
        if (!disposed) setSessions(next)
      })
      .catch(() => {})

    const unsubscribe = window.api.onTerminalSessionsChanged((next) => {
      if (!disposed) setSessions(next)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return sessions
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
  return session.running
    ? { kind: 'running', sessionId: session.sessionId, agentId }
    : { kind: 'exited', sessionId: session.sessionId, agentId }
}
