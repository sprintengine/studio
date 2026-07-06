// Cross-workspace "agents awaiting you" derivation. Pure logic over existing
// session data — no UI, no store access (data arrives via arguments). It folds
// the shared session list down to the rows that actually need the user (an agent
// that asked a question, or one that crashed) and summarizes them for a trigger
// badge. All status and shape logic is reused from workspaceManagerHelpers so
// this surface never re-derives "what is this session doing".

import {
  compareSessionItemsByAttention,
  getSessionItems,
  sessionsAttentionTone,
} from '../components/workspace/workspaceManagerHelpers'
import type { SessionItem } from '../components/workspace/WorkspaceActions'
import type { Workspace } from '../types/workspace'

// Trigger-badge summary. `tone` is null when the badge should be hidden — at
// zero items, or when nothing in the list actually needs attention.
export type AttentionQueueBadge = {
  count: number
  tone: 'warn' | 'error' | null
}

// The two statuses that mean a session is waiting on the user. Working and idle
// sessions are not awaiting anyone, so they never enter the queue.
const ATTENTION_STATUSES: ReadonlySet<SessionItem['status']> = new Set(['needs-input', 'failed'])

// Every session across every workspace that is awaiting the user, attention-first
// (needs-input before failed, then most-recently-active within a tier).
export function buildAttentionQueueItems(
  workspaces: Workspace[],
  terminalSessions: TerminalSessionSnapshot[],
): SessionItem[] {
  return getSessionItems(workspaces, terminalSessions)
    .filter((item) => ATTENTION_STATUSES.has(item.status))
    .sort(compareSessionItemsByAttention)
}

// Trigger-badge count and tone. tone reuses sessionsAttentionTone (warn when any
// needs-input, else error when any failed); its "nothing needs attention" verdict
// — and the empty list — map to null so the badge is simply absent.
export function attentionQueueBadge(items: SessionItem[]): AttentionQueueBadge {
  const tone = sessionsAttentionTone(items)
  return { count: items.length, tone: tone === 'good' ? null : tone }
}
