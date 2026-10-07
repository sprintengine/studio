import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { conversationSummaryPhase } from '../../../../shared/conversation/phase'
import type { TerminalSessionSnapshot } from '../../../../shared/ipc/terminal'
import type { WorkspaceActivity } from './workspaceManagerHelpers'

// "Go to next chat that needs you" (`chat.nextWaiting`): which chats wait on
// the person, in the order one press after another visits them.
//
// The chats are the ones the Home badge counts as waiting: blocked on a
// question or an approval, then a turn that failed. Blocked chats come first
// because their agents can do nothing until answered; a failed one has
// stopped either way. Within each, the longest-waiting comes first: it has
// cost the most idle agent time, and the order holds still while the person
// works through it. The sidebar's own order would not — answering a chat
// moves it to the top of its project.

/** When a chat started waiting on the person; the earliest of its agents'. */
function waitingSince(
  workspaceId: string,
  activity: WorkspaceActivity,
  terminalSessions: readonly TerminalSessionSnapshot[],
  conversationSessions: readonly ConversationSessionSummary[],
): number {
  let since = Number.POSITIVE_INFINITY
  for (const session of terminalSessions) {
    if (session.workspaceId !== workspaceId || session.kind !== 'agent') continue
    if (activity === 'needs-input' && session.processAlive && session.agentState?.phase === 'awaiting_input') {
      since = Math.min(since, session.agentState.since)
    }
    if (activity === 'failed' && session.activity.kind === 'failed') since = Math.min(since, session.activity.at)
  }
  for (const summary of conversationSessions) {
    if (summary.workspaceId !== workspaceId) continue
    const phase = conversationSummaryPhase(summary)
    // When the request that stopped it was made. `updatedAt` is only for a
    // server too old to say: it also moves on a model or permission change.
    if (activity === 'needs-input' && (phase === 'waiting_for_approval' || phase === 'waiting_for_input')) {
      since = Math.min(since, summary.waitingSince ?? summary.updatedAt)
    }
    if (activity === 'failed' && phase === 'failed') {
      since = Math.min(since, summary.lastTurnEndedAt ?? summary.updatedAt)
    }
  }
  return since
}

/**
 * The chats waiting on the person, in visiting order: blocked ones, then
 * failed ones, each longest-waiting first. `workspaceIds` is this window's
 * chats in the sidebar's order, which breaks ties (a chat whose wait has no
 * timestamp sorts after those that do).
 */
export function chatsWaitingOnYou(input: {
  workspaceIds: readonly string[]
  activityByWorkspaceId: Readonly<Record<string, WorkspaceActivity>>
  terminalSessions: readonly TerminalSessionSnapshot[]
  conversationSessions: readonly ConversationSessionSummary[]
}): string[] {
  const rank = { 'needs-input': 0, failed: 1 } as const
  return input.workspaceIds
    .flatMap((workspaceId, index) => {
      const activity = input.activityByWorkspaceId[workspaceId]
      if (activity !== 'needs-input' && activity !== 'failed') return []
      const since = waitingSince(workspaceId, activity, input.terminalSessions, input.conversationSessions)
      return [{ workspaceId, group: rank[activity], since, index }]
    })
    .sort((a, b) => a.group - b.group || a.since - b.since || a.index - b.index)
    .map((entry) => entry.workspaceId)
}

/**
 * The chat one press goes to: the one after the chat on screen in the waiting
 * order, wrapping round, or the first when the chat on screen is not waiting.
 * Null when no chat but the one on screen is waiting.
 */
export function nextWaitingChatId(waiting: readonly string[], onScreenWorkspaceId: string | null): string | null {
  const at = onScreenWorkspaceId ? waiting.indexOf(onScreenWorkspaceId) : -1
  if (at === -1) return waiting[0] ?? null
  if (waiting.length === 1) return null
  return waiting[(at + 1) % waiting.length] ?? null
}
