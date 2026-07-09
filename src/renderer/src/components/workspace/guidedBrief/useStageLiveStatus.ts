import { useConversationSessions } from '../../../hooks/useConversationSessions'
import { useTerminalSessions } from '../../../hooks/useTerminalSessions'
import { CONVERSATION_SESSION_STATUS, deriveSessionStatus } from '../workspaceManagerHelpers'
import type { StageLiveStatus } from './stageReadiness'

export type UseStageLiveStatusInput = {
  // Owning workspace id (undefined disables the read — the wizard runs the
  // legacy transport with no inventoried session then).
  workspaceId: string | undefined
  // Stage specialist id shared across both transports (`guidedBriefSpecialistAgentId`).
  agentId: string
  transport: 'terminal' | 'conversation'
  enabled: boolean
}

// Live specialist status for one wizard stage, read from the SAME stores the
// Sessions popover consumes: conversation session summaries for conversation
// sessions, terminal snapshots (hook phase) for PTY sessions — keyed by
// workspaceId + the stage's `guided-brief-*` agentId. Reusing
// `CONVERSATION_SESSION_STATUS` and `deriveSessionStatus` keeps the wizard's
// status chip and the popover in lockstep, and updates arrive on the
// transport's own status events (no 2.5s poll for status). Both stores are
// self-subscribing singletons, so both are always read before the transport
// branch to keep hook order stable.
export function useStageLiveStatus({
  workspaceId,
  agentId,
  transport,
  enabled,
}: UseStageLiveStatusInput): StageLiveStatus {
  const conversationSessions = useConversationSessions()
  const terminalSessions = useTerminalSessions()

  if (!enabled || !workspaceId) return 'absent'

  if (transport === 'conversation') {
    const summary = conversationSessions.find(
      (session) => session.workspaceId === workspaceId && session.agentId === agentId,
    )
    if (!summary) return 'absent'
    // `stopped` maps to null in the shared map → the session has ended → absent.
    return CONVERSATION_SESSION_STATUS[summary.status] ?? 'absent'
  }

  const snapshot = terminalSessions.find(
    (session) => session.workspaceId === workspaceId && session.agentId === agentId,
  )
  if (!snapshot) return 'absent'
  return deriveSessionStatus(snapshot, false).status
}
