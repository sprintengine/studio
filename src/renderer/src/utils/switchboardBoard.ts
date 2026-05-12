import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SWITCHBOARD_STATUS_LABELS,
  type SwitchboardExecutionStatus,
  type SwitchboardFileProblem,
  type SwitchboardFolderStatus,
  type SwitchboardReadAllResult,
  type SwitchboardTaskRecord,
  type SwitchboardTaskStatus,
} from '../../../shared/switchboard'

const TASK_POLL_INTERVAL_MS = 5_000

export const BOARD_STATUS_ORDER: SwitchboardTaskStatus[] = [
  'planning',
  'todo',
  'ready',
  'in_progress',
  'testing',
  'testing_in_progress',
  'review',
  'review_in_progress',
  'done',
  'canceled',
]

export type SwitchboardLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

export type SwitchboardData = {
  state: SwitchboardLoadState
  tasks: SwitchboardTaskRecord[]
  problems: SwitchboardFileProblem[]
  workspaceRoot: string | null
  switchboardRoot: string | null
  refresh: () => Promise<void>
}

export function useSwitchboardData(workspaceRoot: string | null | undefined): SwitchboardData {
  const [tasks, setTasks] = useState<SwitchboardTaskRecord[]>([])
  const [problems, setProblems] = useState<SwitchboardFileProblem[]>([])
  const [switchboardRoot, setSwitchboardRoot] = useState<string | null>(null)
  const [state, setState] = useState<SwitchboardLoadState>(workspaceRoot ? { kind: 'loading' } : { kind: 'idle' })
  const initializedRef = useRef<string | null>(null)
  const activeRootRef = useRef<string | null>(workspaceRoot ?? null)
  const inFlightRef = useRef(false)

  const refresh = useCallback(async () => {
    activeRootRef.current = workspaceRoot ?? null
    const targetRoot = workspaceRoot ?? null
    const isStale = () => activeRootRef.current !== targetRoot

    if (inFlightRef.current) return

    if (!targetRoot) {
      setState({ kind: 'idle' })
      setTasks([])
      setProblems([])
      setSwitchboardRoot(null)
      return
    }

    inFlightRef.current = true
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))

    try {
      if (initializedRef.current !== targetRoot) {
        const initResult = await window.api.initializeSwitchboard(targetRoot)
        if (isStale()) return
        if (!initResult.ok) {
          setState({ kind: 'error', message: initResult.message })
          setTasks([])
          setProblems([])
          setSwitchboardRoot(null)
          return
        }
        initializedRef.current = targetRoot
        setSwitchboardRoot(initResult.switchboardRoot)
      }

      const result = await window.api.readSwitchboardTasks(targetRoot)
      if (isStale()) return
      if (!result.ok) {
        setState({ kind: 'error', message: result.message })
        return
      }

      const readResult = result as SwitchboardReadAllResult
      setSwitchboardRoot(readResult.switchboardRoot)
      setTasks(readResult.tasks)
      setProblems(readResult.problems)
      setState({ kind: 'ready' })
    } catch (error) {
      if (isStale()) return
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to read Switchboard tasks.',
      })
    } finally {
      inFlightRef.current = false
    }
  }, [workspaceRoot])

  useEffect(() => {
    setTasks([])
    setProblems([])
    setSwitchboardRoot(null)
    void refresh()
    if (!workspaceRoot) return
    const handle = window.setInterval(() => {
      void refresh()
    }, TASK_POLL_INTERVAL_MS)
    return () => window.clearInterval(handle)
  }, [refresh, workspaceRoot])

  return {
    state,
    tasks,
    problems,
    workspaceRoot: workspaceRoot ?? null,
    switchboardRoot,
    refresh,
  }
}

export function groupTasksByStatus(
  tasks: SwitchboardTaskRecord[]
): Record<SwitchboardFolderStatus, SwitchboardTaskRecord[]> {
  const groups = {} as Record<SwitchboardFolderStatus, SwitchboardTaskRecord[]>
  for (const status of [...BOARD_STATUS_ORDER, 'inbox' as const]) {
    groups[status] = []
  }
  for (const record of tasks) {
    const status = record.location.folderStatus
    if (!groups[status]) groups[status] = []
    groups[status].push(record)
  }
  return groups
}

export function statusLabel(status: SwitchboardFolderStatus): string {
  return SWITCHBOARD_STATUS_LABELS[status]
}

export function priorityLabel(priority: number | null): string {
  if (priority == null) return 'No priority'
  if (priority <= 0) return 'Urgent'
  if (priority === 1) return 'High'
  if (priority === 2) return 'Medium'
  if (priority === 3) return 'Low'
  return `P${priority}`
}

export function priorityToneClass(priority: number | null): string {
  if (priority == null) return 'text-[#6f7078]'
  if (priority <= 0) return 'text-[#ff787c]'
  if (priority === 1) return 'text-[#f2c45f]'
  if (priority === 2) return 'text-[#7c5cf2]'
  if (priority === 3) return 'text-[#5c7cff]'
  return 'text-[#9a9aa2]'
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return ''
  const diff = Date.now() - time
  const minutes = Math.round(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

export type LegalStatusTransitions = ReadonlyArray<SwitchboardTaskStatus>

const TRANSITIONS: Record<SwitchboardFolderStatus, SwitchboardTaskStatus[]> = {
  inbox: ['todo', 'canceled'],
  planning: ['todo', 'canceled'],
  todo: ['planning', 'ready', 'canceled'],
  ready: ['todo', 'in_progress', 'canceled'],
  in_progress: ['ready', 'testing', 'canceled'],
  testing: ['in_progress', 'testing_in_progress', 'canceled'],
  testing_in_progress: ['testing', 'review', 'canceled'],
  review: ['testing', 'review_in_progress', 'canceled'],
  review_in_progress: ['review', 'done', 'canceled'],
  done: ['review'],
  canceled: [],
}

export function legalMoveTargets(from: SwitchboardFolderStatus): SwitchboardTaskStatus[] {
  return TRANSITIONS[from] ?? []
}

export function commentSummary(record: SwitchboardTaskRecord): string {
  const total = record.task.comments.length
  if (total === 0) return ''
  return `${total} comment${total === 1 ? '' : 's'}`
}

export function sourceLabel(record: SwitchboardTaskRecord): string {
  const source = record.task.source
  if (source.externalKey) return `${source.type} · ${source.externalKey}`
  if (source.externalId) return `${source.type} · ${source.externalId}`
  return source.type
}

export function shortIdentifier(record: SwitchboardTaskRecord): string {
  return record.task.identifier || record.task.id.slice(0, 8)
}

const CLAIMED_LANE_STATUSES: ReadonlySet<SwitchboardFolderStatus> = new Set([
  'in_progress',
  'testing_in_progress',
  'review_in_progress',
])

const ABANDONED_EXECUTION_STATUSES: ReadonlySet<SwitchboardExecutionStatus> = new Set([
  'abandoned',
  'stopped',
  'stale',
  'missing',
])

export type SwitchboardAttentionReason =
  | SwitchboardExecutionStatus
  | 'lost-track'

export type SwitchboardAttentionInfo = {
  reason: SwitchboardAttentionReason
  attempts: number
  lastAttemptAt: string | null
}

/**
 * Returns attention info iff the task sits in a claimed lane but its
 * latest execution is no longer running. Used to flag tasks that the
 * runner has abandoned (e.g., Electron quit, process crash) so the
 * user can decide to retry, cancel, or investigate.
 */
export function deriveAttentionInfo(
  record: SwitchboardTaskRecord,
  liveExecutionStatus: SwitchboardExecutionStatus | null
): SwitchboardAttentionInfo | null {
  if (!CLAIMED_LANE_STATUSES.has(record.location.folderStatus)) return null
  const attempts = record.task.execution.attempts
  const latest = attempts.length > 0 ? attempts[attempts.length - 1] : null
  const lastAttemptAt = latest?.completedAt ?? latest?.startedAt ?? null

  if (liveExecutionStatus && ABANDONED_EXECUTION_STATUSES.has(liveExecutionStatus)) {
    return { reason: liveExecutionStatus, attempts: attempts.length, lastAttemptAt }
  }
  // No active execution record, but the task was claimed and the latest
  // attempt already completed — the runner lost track of it.
  if (!liveExecutionStatus && latest?.completedAt) {
    return { reason: 'lost-track', attempts: attempts.length, lastAttemptAt }
  }
  return null
}

export function attentionReasonLabel(reason: SwitchboardAttentionReason): string {
  switch (reason) {
    case 'abandoned':
      return 'Abandoned'
    case 'stopped':
      return 'Stopped'
    case 'stale':
      return 'Stale'
    case 'missing':
      return 'Missing'
    case 'lost-track':
      return 'No active execution'
    default:
      return reason
  }
}

export function attentionReasonDescription(reason: SwitchboardAttentionReason): string {
  switch (reason) {
    case 'abandoned':
      return 'The runner exited before this task completed. Retry to move it back to the queue.'
    case 'stopped':
      return 'The execution was stopped before completing. Retry to start a new attempt.'
    case 'stale':
      return 'The runner has not heard from this execution recently. Retry or investigate.'
    case 'missing':
      return 'The execution disappeared from the runner. Retry to start a new attempt.'
    case 'lost-track':
      return 'The task is claimed but no execution is active. Retry to move it back to the queue.'
    default:
      return ''
  }
}
