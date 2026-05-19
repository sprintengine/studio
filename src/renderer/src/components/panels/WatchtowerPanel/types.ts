import type { SwitchboardComment, SwitchboardTaskRecord } from '../../../../../shared/switchboard'
import type { Tone } from '../../ui'

export type DraftTask = {
  title: string
  description: string
  priority: number | null
  labels: string
  identifier: string
}

export type AgentTaskOutcome = {
  count: number
  total?: number
}

export type TriageImportance = 'critical' | 'high' | 'medium' | 'low' | null

export function latestTriageComment(record: SwitchboardTaskRecord): SwitchboardComment | null {
  for (let index = record.task.comments.length - 1; index >= 0; index -= 1) {
    const comment = record.task.comments[index]
    if (comment.kind === 'triage') return comment
  }
  return null
}

export function parseTriageImportance(comment: SwitchboardComment | null): TriageImportance {
  if (!comment) return null
  const match = comment.body.match(/^Importance:\s*(Critical|High|Medium|Low)\s*$/imu)
  return match ? match[1].toLowerCase() as TriageImportance : null
}

export function inboxRowTone(record: SwitchboardTaskRecord): Tone {
  const triageImportance = parseTriageImportance(latestTriageComment(record))
  if (triageImportance === 'critical') return 'error'
  if (triageImportance === 'high') return 'warn'
  if (record.task.source.type === 'watchtower') return 'accent'
  return 'neutral'
}
