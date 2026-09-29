import type { ConversationEvent } from '../../shared/conversation-runtime'

/**
 * Derive an automation run summary from its agent's conversation: the text of
 * the agent's last message in its last turn.
 *
 * A turn narrates as it goes — "I'll read the config first", a tool, "Now the
 * tests", another tool — and closes with what it did. The closing message is
 * the text after the turn's last tool call; text before a tool is narration
 * and is not the summary. A subagent's tools (they carry `parentToolUseId`)
 * are its own and do not split the run agent's message.
 *
 * Pure and engine-free by contract (no import of engine.ts). Never throws.
 */

/** Summary length cap. Longer text is truncated with an ellipsis. */
export const MAX_TRANSCRIPT_SUMMARY_LENGTH = 500

export function summarizeConversationReply(events: readonly ConversationEvent[]): string | undefined {
  let segment = ''
  let lastWorded = ''
  for (const event of events) {
    if (event.type === 'user_message') {
      segment = ''
      lastWorded = ''
    } else if (event.type === 'tool_started' && typeof event.payload?.parentToolUseId !== 'string') {
      if (segment.trim()) lastWorded = segment
      segment = ''
    } else if (event.type === 'content_delta' && typeof event.payload?.text === 'string') {
      segment += event.payload.text
    }
  }
  // A turn that ended on a tool call has no closing message; its last words
  // before that call are the closest thing to one.
  const summary = (segment.trim() ? segment : lastWorded).trim()
  if (!summary) return undefined
  return summary.length > MAX_TRANSCRIPT_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_TRANSCRIPT_SUMMARY_LENGTH - 1).trimEnd()}…`
    : summary
}
