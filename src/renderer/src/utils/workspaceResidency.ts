// "Resident" = a workspace with at least one live agent PTY right now. This is
// the truthful "hot" signal the sidebar bolds: resident workspaces are instant
// to switch into, while suspended/exited ones re-launch their CLI on open (with
// --resume where the plugin supports it).
//
// Keyed off `processAlive`, which tracks the REAL node-pty exit/dispose
// lifecycle — not the soft idle/working activity status that only refreshes when
// a workspace gets attention. When the memory reaper suspends an idle agent it
// disposes the session (processAlive → false) and broadcasts
// terminal:sessions-delta, so a derived set recomputes immediately. Attribution
// is by the session's recorded workspaceId, matching how workspace activity is
// derived elsewhere.
//
// A chat counts while its session is open and its child has not rested. A
// settled, snoozed or idle-swept chat keeps its session (status `ready`) so the
// next message resumes it, but it holds no process until then, so it is no
// warmer to switch into than a suspended terminal agent.

import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'

export function residentAgentWorkspaceIds(
  terminalSessions: TerminalSessionSnapshot[],
  conversationSessions: readonly Pick<ConversationSessionSummary, 'workspaceId' | 'status' | 'resting'>[] = [],
): Set<string> {
  const resident = new Set<string>()
  for (const session of terminalSessions) {
    if (session.kind !== 'agent') continue
    if (!session.processAlive) continue
    if (typeof session.workspaceId !== 'string') continue
    resident.add(session.workspaceId)
  }
  for (const session of conversationSessions) {
    if (session.status === 'stopped' || session.resting) continue
    resident.add(session.workspaceId)
  }
  return resident
}
