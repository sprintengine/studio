import type { ConversationSessionSummary } from '../conversation-runtime'

/** One display phase for a conversation, ordered by the action it needs. */
export type ConversationPhase =
  'idle' | 'starting' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'failed' | 'completed'

export type ConversationPhaseSignals = {
  approvalPending?: boolean
  inputPending?: boolean
  failed?: boolean
  running?: boolean
  starting?: boolean
  completed?: boolean
}

/** A pending human action outranks a process state when both are reported. */
export function conversationPhaseOf(signals: ConversationPhaseSignals): ConversationPhase {
  if (signals.approvalPending) return 'waiting_for_approval'
  if (signals.inputPending) return 'waiting_for_input'
  if (signals.failed) return 'failed'
  if (signals.running) return 'running'
  if (signals.starting) return 'starting'
  if (signals.completed) return 'completed'
  return 'idle'
}

export function conversationPhaseNeedsAttention(phase: ConversationPhase): boolean {
  return phase === 'waiting_for_approval' || phase === 'waiting_for_input' || phase === 'failed'
}

export function conversationSummaryPhase(summary: ConversationSessionSummary): ConversationPhase {
  if (summary.phase) return summary.phase
  return conversationPhaseOf({
    approvalPending: summary.status === 'awaiting_approval',
    failed: summary.status === 'failed',
    running: summary.status === 'active',
    starting: summary.status === 'starting',
    completed: summary.status === 'stopped',
  })
}
