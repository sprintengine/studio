import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection'
export type TurnFold = { kind: 'turn-fold'; id: string; label: string; defaultFolded: boolean }

export function deriveTurnFold(
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>,
  tools: TranscriptToolEntry[],
  isLatest: boolean,
): TurnFold | null {
  if (entry.status === 'streaming') return null
  const settled = tools.filter((tool) => tool.status !== 'running')
  const rows = settled.length + (entry.reasoning.trim() ? 1 : 0)
  if (rows <= 1) return null
  const seconds = Math.max(0, Math.round(((entry.completedAt ?? entry.startedAt ?? 0) - (entry.startedAt ?? 0)) / 1000))
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  const label =
    entry.status === 'failed'
      ? `Failed after ${duration}`
      : entry.status === 'interrupted'
        ? `You stopped after ${duration}`
        : `Worked for ${duration}`
  return {
    kind: 'turn-fold',
    id: `fold:${entry.turnId}`,
    label: `${label}${settled.length ? ` · ${settled.length} steps` : ''}`,
    defaultFolded: !isLatest,
  }
}
