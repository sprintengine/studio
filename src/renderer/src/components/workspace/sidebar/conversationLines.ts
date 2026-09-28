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
  return replyPreviewText(summary.lastAssistantText ?? '') || (phase === 'starting' ? 'Starting' : 'Ready')
}

// Where escaped markdown characters wait out the stripping: the private-use
// block, which no reply's text is written in.
const ESCAPED_BASE = 0xe000

/**
 * A reply's markdown as one line of prose, for the row under an agent's name.
 * The runtime hands over the reply's first characters as written, and in a
 * single truncated line the syntax is all noise: a `#` before the first word,
 * `**` around the second, a link's URL longer than its text. What is left is
 * what the reader would have read. The source is cut mid-reply, so a marker
 * whose partner fell past the cut goes too.
 */
export function replyPreviewText(markdown: string): string {
  // An escaped marker is a character the writer meant literally; it is set
  // aside before the markers are read and put back as itself at the end.
  const escaped = markdown.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/gu, (_, char: string) =>
    String.fromCharCode(ESCAPED_BASE + char.charCodeAt(0)),
  )
  const lines: string[] = []
  for (const raw of escaped.split(/\r?\n/u)) {
    let line = raw.trim()
    // A fence line, a rule or a table's alignment row says nothing on its own.
    if (/^(?:`{3,}|~{3,})/u.test(line) || /^(?:[-*_]\s*){3,}$/u.test(line) || /^\|?[\s:|-]+\|[\s:|-]*$/u.test(line))
      continue
    line = line
      .replace(/^(?:>\s?)+/u, '')
      .replace(/^#{1,6}\s+/u, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/u, '')
      .replace(/^\[[ xX]\]\s+/u, '')
      .replace(/^\|\s*|\s*\|$/gu, '')
      .replace(/\s+\|\s+/gu, ' · ')
    if (line) lines.push(line)
  }
  return lines
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)?/gu, '$1')
    .replace(/\[([^\]]+)\](?:\([^)]*\)?|\[[^\]]*\])/gu, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/gu, '$1')
    .replace(/`+/gu, '')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/gu, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/gu, '$1$2')
    .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/gu, '$1$2')
    .replace(/\*\*|__|~~/gu, '')
    .replace(/[\uE000-\uE07F]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - ESCAPED_BASE))
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * When a resting chat last finished a turn, for the "how long since" readings
 * on its sidebar line and its tab. Null while a turn is open or waiting on a
 * person (those surfaces say working or waiting instead), and for a chat that
 * has never finished one.
 */
export function conversationFinishedAt(summary: ConversationSessionSummary): number | null {
  const phase = conversationSummaryPhase(summary)
  if (phase !== 'completed' && phase !== 'failed' && phase !== 'idle') return null
  return summary.lastTurnEndedAt ?? null
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
