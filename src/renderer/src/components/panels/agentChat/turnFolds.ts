import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection'
import { flattenToolEntries } from './conversationTimeline'
import { stepWentWrong } from './toolRows/ToolRow'

// `failed` counts the steps that went wrong, a lane's own included: an older
// turn rests folded, and a failure inside it must still show on the fold.
export type TurnFold = { kind: 'turn-fold'; id: string; label: string; defaultFolded: boolean; failed: number }

export function deriveTurnFold(
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>,
  tools: TranscriptToolEntry[],
  isLatest: boolean,
): TurnFold | null {
  if (entry.status === 'streaming') return null
  const settled = tools.filter((tool) => tool.status !== 'running')
  const rows =
    settled.length +
    (entry.reasoning.trim() ? 1 : 0) +
    (entry.reasoningSegments?.length ?? 0) +
    (entry.intermediateText?.length ?? 0)
  if (rows <= 1) return null
  // An entry without both ends has no honest duration; a missing start read as
  // 0 would claim the turn ran since 1970.
  const elapsedMs =
    entry.startedAt !== undefined && entry.completedAt !== undefined
      ? entry.completedAt - entry.startedAt
      : entry.durationMs
  const seconds = elapsedMs === undefined ? undefined : Math.max(0, Math.round(elapsedMs / 1000))
  const duration =
    seconds === undefined ? '' : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  const label =
    entry.status === 'failed'
      ? duration
        ? `Failed after ${duration}`
        : 'Failed'
      : entry.status === 'interrupted'
        ? duration
          ? `You stopped after ${duration}`
          : 'You stopped'
        : duration
          ? `Worked for ${duration}`
          : 'Worked'
  return {
    kind: 'turn-fold',
    id: `fold:${entry.turnId}`,
    label: `${label}${settled.length ? ` · ${settled.length} ${settled.length === 1 ? 'step' : 'steps'}` : ''}`,
    defaultFolded: !isLatest,
    failed: flattenToolEntries(settled).filter(stepWentWrong).length,
  }
}

/**
 * The turn that answers the latest message: it stays unfolded. A continuation
 * turn (a background agent reporting after its turn ended) has no message of
 * its own, so it must not take that place and fold the reply being read.
 */
export function latestReplyTurnId(entries: readonly TranscriptEntry[]): string | undefined {
  let latest: string | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    // A message still waiting for its reply leaves the previous reply open.
    if (entry.kind === 'user' && latest !== undefined) return latest
    if (entry.kind === 'assistant') latest = entry.turnId
  }
  return latest
}
