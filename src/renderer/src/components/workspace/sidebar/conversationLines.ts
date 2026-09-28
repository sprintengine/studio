import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { conversationSummaryPhase, type ConversationPhase } from '../../../../../shared/conversation/phase'
import { labelForCliRuntime } from '../newWorkspace/cliRuntimeOptions'
import type { Activity } from './rowStyle'

/**
 * What a chat's mark says: the CLI it rides, so a chat line wears the same
 * provider mark a terminal line does and the two read as the same agent on a
 * different surface. `cli` is null for a provider that is not a CLI (the
 * API-key providers), which keep the chat glyph.
 */
export function conversationLineMark(
  summary: Pick<ConversationSessionSummary, 'providerId' | 'modelId' | 'displayName'>,
): {
  cli: string | null
  runtimeLabel: string
  tooltip: string
} {
  const cli = cliForConversationProvider(summary.providerId)
  const runtimeLabel = cli ? `${labelForCliRuntime(cli)} chat` : 'Chat'
  const parts = [summary.displayName?.trim(), runtimeLabel, summary.modelId].filter(Boolean)
  return { cli, runtimeLabel, tooltip: parts.join(' · ') }
}

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
