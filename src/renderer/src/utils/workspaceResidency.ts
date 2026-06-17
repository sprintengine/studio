// "Resident" = a workspace with at least one live agent PTY right now. This is
// the truthful "hot" signal the sidebar bolds: resident workspaces are instant
// to switch into, while suspended/exited ones re-launch their CLI on open (with
// --resume where the plugin supports it).
//
// Keyed off `processAlive`, which tracks the REAL node-pty exit/dispose
// lifecycle — not the soft idle/working activity status that only refreshes when
// a workspace gets attention. When the memory reaper suspends an idle agent it
// disposes the session (processAlive → false) and broadcasts
// terminal:sessions-changed, so a derived set recomputes immediately. Attribution
// is by the session's recorded workspaceId, matching how workspace activity is
// derived elsewhere.

export function residentAgentWorkspaceIds(
  terminalSessions: TerminalSessionSnapshot[],
): Set<string> {
  const resident = new Set<string>()
  for (const session of terminalSessions) {
    if (session.kind !== 'agent') continue
    if (!session.processAlive) continue
    if (typeof session.workspaceId !== 'string') continue
    resident.add(session.workspaceId)
  }
  return resident
}
