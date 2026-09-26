import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { conversationSummaryPhase, type ConversationPhase } from '../../../../../shared/conversation/phase'
import type { Activity } from './rowStyle'

export function conversationLineText(summary: ConversationSessionSummary): string {
  const phase = conversationSummaryPhase(summary)
  if (phase === 'waiting_for_approval') return 'Needs approval'
  if (phase === 'waiting_for_input') return 'Asked a question'
  if (phase === 'failed') return 'Failed'
  if (phase === 'running') return summary.currentToolTitle?.trim() || 'Thinking'
  return summary.lastAssistantText?.trim() || (phase === 'starting' ? 'Starting' : 'Ready')
}

export function conversationPhaseActivity(phase: ConversationPhase): Activity {
  if (phase === 'waiting_for_approval' || phase === 'waiting_for_input') return 'needs-input'
  if (phase === 'failed') return 'failed'
  if (phase === 'running' || phase === 'starting') return 'working'
  return 'idle'
}

/** The row's existing status vocabulary, including when a terminal shares it. */
export function combinedAgentActivity(
  terminal: Activity,
  conversations: readonly ConversationSessionSummary[],
): Activity {
  const rank: Record<Activity, number> = { idle: 0, working: 1, failed: 2, 'needs-input': 3 }
  let result = terminal
  for (const summary of conversations) {
    const next = conversationPhaseActivity(conversationSummaryPhase(summary))
    if (rank[next] > rank[result]) result = next
  }
  return result
}
