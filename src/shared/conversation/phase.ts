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
  const phase = summary.phase ?? statusPhase(summary)
  // Background agents keep working after the turn that launched them ends.
  if (summary.backgroundAgents && (phase === 'completed' || phase === 'idle')) return 'running'
  return phase
}

function statusPhase(summary: ConversationSessionSummary): ConversationPhase {
  return conversationPhaseOf({
    approvalPending: summary.status === 'awaiting_approval',
    failed: summary.status === 'failed',
    running: summary.status === 'active',
    starting: summary.status === 'starting',
    completed: summary.status === 'stopped',
  })
}

/**
 * Whether stopping the chat now would cut a turn short: one starting, running
 * (background agents included), or stopped on a question or an approval. What
 * a quit asks about; a finished, failed or resting chat loses nothing.
 */
export function conversationTurnInProgress(summary: ConversationSessionSummary): boolean {
  const phase = conversationSummaryPhase(summary)
  return (
    phase === 'starting' || phase === 'running' || phase === 'waiting_for_approval' || phase === 'waiting_for_input'
  )
}
