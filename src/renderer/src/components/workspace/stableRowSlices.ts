// Per-row values that keep their identity while what they say is unchanged.
//
// The manager recomputes its per-workspace maps whenever a terminal or a chat
// moves anywhere. Each sidebar row is memoized on its own slice of those maps,
// so a slice rebuilt with equal contents must be the previous object, or every
// row re-renders for news about one of them. The whole map keeps its identity
// too when no slice moved, so the effects keyed on it do not re-run. The tab
// strip gets the same treatment from `conversationTabSignature`.

import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { backgroundTasksWakeAgent } from '../../../../shared/conversation/backgroundTasks'

export type RowRecency = {
  hasRunning: boolean
  idleSince: number | null
  lastInputAt: number | null
  workingSince: number | null
}

export function recencyEqual(a: RowRecency, b: RowRecency): boolean {
  return (
    a.hasRunning === b.hasRunning &&
    a.idleSince === b.idleSince &&
    a.lastInputAt === b.lastInputAt &&
    a.workingSince === b.workingSince
  )
}

/**
 * `next`, with every value equal to the previous one's swapped back for it,
 * and `previous` itself when no key and no value moved.
 */
export function stableRecord<V>(
  next: Record<string, V>,
  previous: Record<string, V> | null,
  equal: (a: V, b: V) => boolean = Object.is,
): Record<string, V> {
  if (!previous) return next
  let same = true
  let count = 0
  for (const key in next) {
    count += 1
    const prior = previous[key]
    if (prior !== undefined && (prior === next[key] || equal(prior, next[key]))) next[key] = prior
    else same = false
  }
  if (same && count === Object.keys(previous).length) return previous
  return next
}

/** `previous` when it holds exactly the same members as `next`. */
export function stableSet<T>(next: Set<T>, previous: ReadonlySet<T> | null): ReadonlySet<T> {
  if (!previous || previous.size !== next.size) return next
  for (const member of next) if (!previous.has(member)) return next
  return previous
}

/**
 * The fields of a workspace's chats that its tabs draw: which agent, its
 * phase and status (and the background agents that keep it working), its
 * provider and model, when its last turn ended, and its prompt cache. A chat's
 * summary also moves on every reply and tool title, which no tab shows.
 */
export function conversationTabSignature(sessions: readonly ConversationSessionSummary[]): string {
  let signature = ''
  for (const session of sessions) {
    const cache = session.promptCache
    signature += `${session.sessionId}|${session.agentId}|${session.status}|${session.phase ?? ''}|${
      session.backgroundAgents ?? 0
    }|${backgroundTasksWakeAgent(session.backgroundTasks) ? 'w' : ''}|${session.providerId}|${session.modelId}|${session.lastTurnEndedAt ?? ''}|${
      cache ? `${cache.ttl}:${cache.expiresAt}:${cache.recacheTokens}` : ''
    }\n`
  }
  return signature
}
