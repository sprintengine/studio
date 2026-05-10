import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { CommentIcon, PriorityIcon, StatusIcon } from '../AppIcons'
import {
  BOARD_STATUS_ORDER,
  formatRelativeTime,
  groupTasksByStatus,
  legalMoveTargets,
  priorityLabel,
  shortIdentifier,
  sourceLabel,
  statusLabel,
  useSwitchboardData,
} from '../../utils/switchboardBoard'
import {
  providerLabel,
  RUNNER_PROVIDERS,
  RUNNER_QUEUES,
  runnerQueueLabel,
  useSwitchboardRunner,
  type RunnerStatusKind,
  type SwitchboardRunner,
} from '../../utils/switchboardRunner'
import type {
  SwitchboardExecutionProviderKind,
  SwitchboardExecutionStatus,
  SwitchboardFolderStatus,
  SwitchboardRunnerExecution,
  SwitchboardRunnerQueue,
  SwitchboardRunnerState,
  SwitchboardTaskRecord,
  SwitchboardTaskStatus,
} from '../../../../shared/switchboard'

const PANEL_BG = 'bg-[#08090b]'
const ACCENT = '#7c5cf2'

type ToastTone = 'info' | 'success' | 'error'
type Toast = { tone: ToastTone; message: string }

type DraftTask = {
  title: string
  description: string
  priority: number | null
  identifier: string
  labels: string
}

const emptyDraft: DraftTask = {
  title: '',
  description: '',
  priority: null,
  identifier: '',
  labels: '',
}

export default function SwitchboardBoardPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const folderPath = workspace?.folderPath ?? null
  const { state, tasks, problems, refresh, switchboardRoot } = useSwitchboardData(folderPath)
  const runner = useSwitchboardRunner(folderPath)

  const grouped = useMemo(() => groupTasksByStatus(tasks), [tasks])
  const boardTasks = useMemo(
    () => tasks.filter((record) => record.location.folderStatus !== 'inbox'),
    [tasks]
  )
  const executionStatusByTaskId = useMemo(() => {
    const map = new Map<string, SwitchboardExecutionStatus>()
    const executions = runner.state?.activeExecutions ?? []
    for (const execution of executions) {
      if (execution.status) map.set(execution.taskId, execution.status)
    }
    return map
  }, [runner.state])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState<DraftTask>(emptyDraft)
  const [commentBody, setCommentBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [dragSource, setDragSource] = useState<{ taskId: string; from: SwitchboardFolderStatus } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ lane: SwitchboardTaskStatus; index: number } | null>(null)
  const dragLegalTargets = useMemo(
    () => (dragSource ? new Set<SwitchboardTaskStatus>(legalMoveTargets(dragSource.from)) : new Set<SwitchboardTaskStatus>()),
    [dragSource]
  )

  useEffect(() => {
    if (!toast) return
    if (toast.tone === 'error') return
    const handle = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(handle)
  }, [toast])

  useEffect(() => {
    if (selectedId && !boardTasks.some((record) => record.task.id === selectedId)) {
      setSelectedId(boardTasks[0]?.task.id ?? null)
    }
  }, [boardTasks, selectedId])

  const selected = useMemo(
    () => boardTasks.find((record) => record.task.id === selectedId) ?? null,
    [boardTasks, selectedId]
  )

  const showToast = useCallback((tone: ToastTone, message: string) => {
    setToast({ tone, message })
  }, [])

  const handleCreate = useCallback(async () => {
    if (!folderPath || !draft.title.trim()) return
    setBusy(true)
    try {
      const labels = draft.labels.split(',').map((label) => label.trim()).filter(Boolean)
      const result = await window.api.createSwitchboardTask({
        workspaceRoot: folderPath,
        origin: 'board',
        title: draft.title.trim(),
        description: draft.description,
        priority: draft.priority,
        labels,
        identifier: draft.identifier.trim() || undefined,
        source: { type: 'manual' },
      })
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      setSelectedId(result.record.task.id)
      setDraft(emptyDraft)
      setCreateOpen(false)
      await refresh()
      showToast('success', 'Task added to Todo.')
    } finally {
      setBusy(false)
    }
  }, [draft, folderPath, refresh, showToast])

  const handleMove = useCallback(
    async (record: SwitchboardTaskRecord, to: SwitchboardTaskStatus) => {
      if (!folderPath) return
      setBusy(true)
      try {
        const result = await window.api.moveSwitchboardTask({
          workspaceRoot: folderPath,
          id: record.task.id,
          to,
        })
        if (!result.ok) {
          showToast('error', result.message)
          return
        }
        await refresh()
        showToast('success', `Moved to ${statusLabel(to)}.`)
      } finally {
        setBusy(false)
      }
    },
    [folderPath, refresh, showToast]
  )

  const handleAddComment = useCallback(async () => {
    if (!folderPath || !selected || !commentBody.trim()) return
    setBusy(true)
    try {
      const result = await window.api.addSwitchboardComment({
        workspaceRoot: folderPath,
        id: selected.task.id,
        body: commentBody.trim(),
        author: { type: 'user', name: 'You' },
        kind: 'comment',
      })
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      setCommentBody('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [commentBody, folderPath, refresh, selected, showToast])

  if (!workspace) {
    return <div className={`h-full ${PANEL_BG} p-4 text-sm text-[#8a8a92]`}>Workspace not found.</div>
  }

  if (!folderPath) {
    return (
      <div className={`h-full ${PANEL_BG} p-6 text-sm text-[#8a8a92]`}>
        Choose a workspace folder to use the Switchboard board.
      </div>
    )
  }

  return (
    <div className={`relative flex h-full min-h-0 ${PANEL_BG} text-[#d7d7dc]`}>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-[#1f2025] px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: ACCENT }}
              aria-hidden="true"
            />
            <span className="shrink-0 text-[11px] text-[#6f7078]">{boardTasks.length} tasks</span>
            {switchboardRoot ? (
              <span className="ml-2 hidden truncate font-mono text-[11px] text-[#5a5a63] md:inline">
                {switchboardRoot}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refresh()}
              className="h-7 rounded border border-[#2a2b31] px-2 text-[11px] font-medium text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee]"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="h-7 rounded border border-[#3b2f63] bg-[#1a1530] px-2.5 text-[11px] font-semibold text-[#efe5ff] hover:bg-[#221a3a]"
            >
              + New task
            </button>
          </div>
        </header>

        <RunnerToolbar runner={runner} workspaceId={workspaceId} onRefresh={refresh} onNotify={showToast} />

        {state.kind === 'error' ? <Banner tone="error" message={state.message} onRetry={refresh} /> : null}
        {problems.length > 0 ? (
          <Banner
            tone="warning"
            message={`${problems.length} task file${problems.length === 1 ? '' : 's'} could not be parsed and was skipped.`}
          />
        ) : null}

        <div className="flex min-h-0 flex-1 gap-1.5 overflow-x-auto px-1.5 py-2">
          {state.kind === 'loading' && boardTasks.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center text-[12px] text-[#6f7078]">
              Loading board...
            </div>
          ) : (
            BOARD_STATUS_ORDER.map((status) => {
              const isLegalDropTarget = Boolean(dragSource) && dragLegalTargets.has(status)
              const isSourceLane = dragSource?.from === status
              return (
                <BoardLane
                  key={status}
                  status={status}
                  records={grouped[status] ?? []}
                  executionStatusByTaskId={executionStatusByTaskId}
                  selectedId={selectedId}
                  onSelect={(id) => setSelectedId(id)}
                  dragActive={Boolean(dragSource)}
                  isLegalDropTarget={isLegalDropTarget}
                  isSourceLane={isSourceLane}
                  dropIndex={dropTarget?.lane === status ? dropTarget.index : null}
                  onDragOverLane={(index) => {
                    if (!isLegalDropTarget) return
                    setDropTarget((current) => {
                      if (current?.lane === status && current.index === index) return current
                      return { lane: status, index }
                    })
                  }}
                  onDragLeaveLane={() => {
                    setDropTarget((current) => (current?.lane === status ? null : current))
                  }}
                  onDropLane={() => {
                    if (!dragSource || !isLegalDropTarget) return
                    const record = tasks.find((task) => task.task.id === dragSource.taskId)
                    if (record) void handleMove(record, status)
                    setDragSource(null)
                    setDropTarget(null)
                  }}
                  onCardDragStart={(record) => {
                    setDragSource({ taskId: record.task.id, from: record.location.folderStatus })
                  }}
                  onCardDragEnd={() => {
                    setDragSource(null)
                    setDropTarget(null)
                  }}
                />
              )
            })
          )}
        </div>
      </section>

      <aside
        className="flex w-[42%] min-w-[320px] max-w-[520px] flex-col border-l border-[#13141a]"
        aria-label="Selected task detail"
      >
        {selected ? (
          <BoardDetailPane
            record={selected}
            executionStatus={executionStatusByTaskId.get(selected.task.id) ?? null}
            commentBody={commentBody}
            onCommentChange={setCommentBody}
            onAddComment={handleAddComment}
            onMove={(to) => void handleMove(selected, to)}
            busy={busy}
          />
        ) : (
          <EmptyDetail />
        )}
      </aside>

      {createOpen ? (
        <CreateTaskDialog
          draft={draft}
          onChange={setDraft}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
          busy={busy}
        />
      ) : null}

      {toast ? <ToastBanner toast={toast} /> : null}
    </div>
  )
}

function BoardLane({
  status,
  records,
  executionStatusByTaskId,
  selectedId,
  onSelect,
  dragActive,
  isLegalDropTarget,
  isSourceLane,
  dropIndex,
  onDragOverLane,
  onDragLeaveLane,
  onDropLane,
  onCardDragStart,
  onCardDragEnd,
}: {
  status: SwitchboardTaskStatus
  records: SwitchboardTaskRecord[]
  executionStatusByTaskId: Map<string, SwitchboardExecutionStatus>
  selectedId: string | null
  onSelect: (id: string) => void
  dragActive: boolean
  isLegalDropTarget: boolean
  isSourceLane: boolean
  dropIndex: number | null
  onDragOverLane: (index: number) => void
  onDragLeaveLane: () => void
  onDropLane: () => void
  onCardDragStart: (record: SwitchboardTaskRecord) => void
  onCardDragEnd: () => void
}) {
  const listRef = useRef<HTMLOListElement | null>(null)
  const dimmed = dragActive && !isLegalDropTarget && !isSourceLane
  const laneClass = [
    'flex h-full w-[260px] shrink-0 flex-col rounded-md transition-colors',
    isLegalDropTarget
      ? 'bg-[#0c0d11] ring-1 ring-[#2a2350]'
      : 'bg-[#0a0b0e]',
    dimmed ? 'opacity-40' : '',
  ].filter(Boolean).join(' ')
  const computeDropIndex = (clientY: number): number => {
    const list = listRef.current
    if (!list) return 0
    const cards = list.querySelectorAll('[data-card="true"]')
    for (let i = 0; i < cards.length; i += 1) {
      const rect = cards[i].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return i
    }
    return cards.length
  }
  return (
    <div
      className={laneClass}
      role="group"
      aria-label={`${statusLabel(status)} lane`}
      onDragOver={(event) => {
        if (!isLegalDropTarget) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onDragOverLane(computeDropIndex(event.clientY))
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        onDragLeaveLane()
      }}
      onDrop={(event) => {
        if (!isLegalDropTarget) return
        event.preventDefault()
        onDropLane()
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-2.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusIcon status={status} className="h-3.5 w-3.5 shrink-0 text-[#9a9aa2]" />
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[#9a9aa2]">
            {statusLabel(status)}
          </span>
        </span>
        <span className="text-[11px] tabular-nums text-[#6f7078]">{records.length}</span>
      </div>
      <ol ref={listRef} className="flex-1 space-y-2 overflow-auto px-2 py-2">
        {records.length === 0 ? (
          <li className="px-1 py-2 text-[11px] text-[#5a5a63]">
            {dropIndex === 0 ? <DropIndicator /> : 'Empty'}
          </li>
        ) : (
          records.map((record, index) => (
            <Fragment key={record.task.id}>
              {dropIndex === index ? <DropIndicator /> : null}
              <BoardCard
                record={record}
                executionStatus={executionStatusByTaskId.get(record.task.id) ?? null}
                selected={selectedId === record.task.id}
                onSelect={() => onSelect(record.task.id)}
                onDragStart={() => onCardDragStart(record)}
                onDragEnd={onCardDragEnd}
              />
              {index === records.length - 1 && dropIndex === records.length ? <DropIndicator /> : null}
            </Fragment>
          ))
        )}
      </ol>
    </div>
  )
}

function BoardCard({
  record,
  executionStatus,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  record: SwitchboardTaskRecord
  executionStatus: SwitchboardExecutionStatus | null
  selected: boolean
  onSelect: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const task = record.task
  const labels = task.labels.slice(0, 2)
  const commentCount = task.comments.length
  const hasActiveExecutionPointer = Boolean(task.execution.activeExecutionId)
  const effectiveStatus: SwitchboardExecutionStatus | null = executionStatus
    ?? (hasActiveExecutionPointer ? 'active' : null)
  const [dragging, setDragging] = useState(false)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLLIElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }

  return (
    <li
      data-card="true"
      draggable
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={`${task.title} (${statusLabel(record.location.folderStatus)})`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', task.id)
        setDragging(true)
        onDragStart()
      }}
      onDragEnd={() => {
        setDragging(false)
        onDragEnd()
      }}
      className={`relative rounded-md border px-2.5 py-2 shadow-[0_1px_0_rgba(0,0,0,0.4)] transition-colors focus:outline-none focus:ring-1 focus:ring-[#7c5cf2] ${
        dragging ? 'cursor-grabbing opacity-60' : 'cursor-grab'
      } ${
        selected
          ? 'border-[#16171c] border-l-[3px] border-l-[#7c5cf2] bg-[#100c1e] pl-[7px] text-[#ececee]'
          : 'border-[#16171c] bg-[#0d0e11] text-[#d7d7dc] hover:bg-[#111216]'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className={`font-mono tabular-nums ${selected ? 'text-[#cdbcff]' : 'text-[#8a8a92]'}`}>
          {shortIdentifier(record)}
        </span>
        <PriorityIcon
          priority={task.priority}
          className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-[#cdbcff]' : 'text-[#9a9aa2]'}`}
        />
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] font-medium leading-5">{task.title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[#6f7078]">
        {labels.map((label) => (
          <span key={label} className="rounded border border-[#2a2b31] bg-[#08090b] px-1.5 py-0.5 text-[#a8a8b0]">
            {label}
          </span>
        ))}
        {commentCount > 0 ? (
          <span className="flex items-center gap-1 text-[#9a9aa2]">
            <CommentIcon className="h-3 w-3 shrink-0" />
            <span className="tabular-nums">{commentCount}</span>
          </span>
        ) : null}
        {effectiveStatus ? (
          <ExecutionStatusBadge status={effectiveStatus} title={executionTitle(record)} />
        ) : null}
        {record.warnings.length > 0 ? (
          <span className="text-[#f2c45f]" title={record.warnings.join('; ')}>
            ⚠
          </span>
        ) : null}
      </div>
    </li>
  )
}

function DropIndicator() {
  return (
    <li aria-hidden="true" className="-my-1 list-none">
      <div className="h-[2px] rounded-full bg-[#7c5cf2] shadow-[0_0_6px_rgba(124,92,242,0.6)]" />
    </li>
  )
}

const EXECUTION_STATUS_LABELS: Record<SwitchboardExecutionStatus, string> = {
  active: 'exec',
  abandoned: 'abandoned',
  stale: 'stale',
  missing: 'missing',
  completed: 'completed',
  stopped: 'stopped',
}

const EXECUTION_STATUS_TONES: Record<SwitchboardExecutionStatus, string> = {
  active: 'border-[#1f3949] bg-[#0d1922] text-[#9fd8ff]',
  abandoned: 'border-[#3a2222] bg-[#1c1414] text-[#ffb3b5]',
  stale: 'border-[#3a3426] bg-[#1d1714] text-[#f2c45f]',
  missing: 'border-[#3a2222] bg-[#1c1414] text-[#ff9ea0]',
  completed: 'border-[#234d27] bg-[#0f1d10] text-[#9be39e]',
  stopped: 'border-[#4a2527] bg-[#1c1414] text-[#ffb3b5]',
}

function ExecutionStatusBadge({ status, title }: { status: SwitchboardExecutionStatus; title?: string }) {
  return (
    <span
      title={title}
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${EXECUTION_STATUS_TONES[status]}`}
    >
      {EXECUTION_STATUS_LABELS[status]}
    </span>
  )
}

const ATTEMPT_DOT_TONES: Record<SwitchboardExecutionStatus, string> = {
  active: 'bg-[#9fd8ff]',
  abandoned: 'bg-[#ffb3b5]',
  stale: 'bg-[#f2c45f]',
  missing: 'bg-[#ff9ea0]',
  completed: 'bg-[#9be39e]',
  stopped: 'bg-[#9a9aa2]',
}

function inferAttemptStatus(
  attempt: { completedAt?: string | null },
  isLatest: boolean,
  liveStatus: SwitchboardExecutionStatus | null
): SwitchboardExecutionStatus {
  if (attempt.completedAt) return 'completed'
  if (isLatest && liveStatus) return liveStatus
  return 'abandoned'
}

function AttemptRow({
  attempt,
  status,
}: {
  attempt: {
    id: string
    agentId?: string | null
    startedAt: string
    completedAt?: string | null
    summary?: string | null
    worktreeBranch?: string | null
    worktreeState?: string | null
  }
  status: SwitchboardExecutionStatus
}) {
  return (
    <li className="grid grid-cols-[10px_1fr] items-start gap-3">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 rounded-full ${ATTEMPT_DOT_TONES[status]}`}
      />
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-[12px] text-[#d7d7dc]">
            {attempt.agentId ?? attempt.id}
          </span>
          <ExecutionStatusBadge status={status} />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-[#9a9aa2] tabular-nums">
          <span>started {formatRelativeTime(attempt.startedAt)}</span>
          {attempt.completedAt ? (
            <>
              <span className="text-[#5a5a63]">·</span>
              <span>ended {formatRelativeTime(attempt.completedAt)}</span>
            </>
          ) : null}
        </div>
        {attempt.worktreeBranch || attempt.worktreeState ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-[#6f7078]">
            {attempt.worktreeBranch ? (
              <span className="font-mono text-[#a1a1aa]">{attempt.worktreeBranch}</span>
            ) : null}
            {attempt.worktreeBranch && attempt.worktreeState ? <span>·</span> : null}
            {attempt.worktreeState ? <span>{attempt.worktreeState}</span> : null}
          </div>
        ) : null}
        {attempt.summary ? (
          <div className="text-[11.5px] leading-5 text-[#9a9aa2]">{attempt.summary}</div>
        ) : null}
      </div>
    </li>
  )
}

function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[#6f7078]">
      <div className="text-[12px] uppercase tracking-[0.08em] text-[#5a5a63]">Detail</div>
      <div className="text-[13px] text-[#8a8a92]">Select a task to inspect its description, comments, and source.</div>
    </div>
  )
}

function BoardDetailPane({
  record,
  executionStatus,
  commentBody,
  onCommentChange,
  onAddComment,
  onMove,
  busy,
}: {
  record: SwitchboardTaskRecord
  executionStatus: SwitchboardExecutionStatus | null
  commentBody: string
  onCommentChange: (next: string) => void
  onAddComment: () => void
  onMove: (to: SwitchboardTaskStatus) => void
  busy: boolean
}) {
  const task = record.task
  const targets = legalMoveTargets(record.location.folderStatus)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[#1f2025] px-5 py-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-[#6f7078]">
          <span className="font-mono tabular-nums text-[12px] text-[#cdbcff]">{shortIdentifier(record)}</span>
          <span>·</span>
          <span className="flex items-center gap-1.5">
            <StatusIcon status={record.location.folderStatus} className="h-3 w-3 text-[#9a9aa2]" />
            {statusLabel(record.location.folderStatus)}
          </span>
          <span>·</span>
          <span className="tabular-nums">{formatRelativeTime(task.updatedAt)}</span>
        </div>
        <h3 className="mt-2 text-[18px] font-semibold leading-7 text-[#ececee]">{task.title}</h3>
        {targets.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Move task">
            {targets.map((target) => (
              <button
                key={target}
                type="button"
                onClick={() => onMove(target)}
                disabled={busy}
                className={`h-7 rounded border px-2.5 text-[11px] font-medium transition-colors ${
                  target === 'canceled'
                    ? 'border-[#3a2222] text-[#ffb3b5] hover:bg-[#1c1414]'
                    : 'border-[#2a2b31] text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee]'
                } disabled:opacity-50`}
              >
                {target === 'canceled' ? 'Cancel' : `→ ${statusLabel(target)}`}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {record.warnings.length > 0 ? (
        <div className="border-b border-[#1f2025] bg-[#1d1714] px-5 py-2 text-[11.5px] leading-5 text-[#f2c45f]">
          {record.warnings.map((warning, idx) => (
            <div key={idx}>{warning}</div>
          ))}
        </div>
      ) : null}

      <div className="flex-1 overflow-auto px-5 py-4">
        <PropertyRow label="Identifier">
          <span className="font-mono text-[12px] text-[#d7d7dc]">{task.identifier}</span>
        </PropertyRow>
        <PropertyRow label="Status">
          <span className="flex items-center gap-2 text-[12px] text-[#d7d7dc]">
            <StatusIcon status={record.location.folderStatus} className="h-3.5 w-3.5 shrink-0 text-[#9a9aa2]" />
            {statusLabel(record.location.folderStatus)}
          </span>
        </PropertyRow>
        <PropertyRow label="Priority">
          <span className="flex items-center gap-2 text-[12px] text-[#d7d7dc]">
            <PriorityIcon priority={task.priority} className="h-3.5 w-3.5 shrink-0 text-[#9a9aa2]" />
            {priorityLabel(task.priority)}
          </span>
        </PropertyRow>
        <PropertyRow label="Labels">
          {task.labels.length > 0 ? (
            <span className="flex flex-wrap gap-1.5">
              {task.labels.map((label) => (
                <span
                  key={label}
                  className="rounded border border-[#2a2b31] bg-[#111216] px-2 py-0.5 text-[11px] text-[#d7d7dc]"
                >
                  {label}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-[12px] text-[#6f7078]">None</span>
          )}
        </PropertyRow>
        <PropertyRow label="Source">
          <span className="text-[12px] text-[#d7d7dc]">{sourceLabel(record)}</span>
        </PropertyRow>
        {task.url ? (
          <PropertyRow label="Link">
            <span className="truncate text-[12px] text-[#cdbcff]">{task.url}</span>
          </PropertyRow>
        ) : null}
        <PropertyRow label="Updated">
          <span className="text-[12px] text-[#9a9aa2]">{task.updatedAt}</span>
        </PropertyRow>
        <PropertyRow label="Execution">
          {task.execution.activeExecutionId || executionStatus ? (
            <span className="block space-y-1 text-[12px] text-[#d7d7dc]">
              <span className="flex items-center gap-2">
                {executionStatus ? (
                  <ExecutionStatusBadge status={executionStatus} />
                ) : task.execution.activeExecutionId ? (
                  <ExecutionStatusBadge status="active" />
                ) : null}
                {task.execution.activeExecutionId ? (
                  <span className="truncate font-mono text-[#d7d7dc]">{task.execution.activeExecutionId}</span>
                ) : null}
              </span>
              {task.execution.activeProvider || task.execution.activeSessionId ? (
                <span className="block text-[#9a9aa2]">
                  {task.execution.activeProvider ?? 'unknown provider'}
                  {task.execution.activeSessionId ? ` · session ${task.execution.activeSessionId}` : ''}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-[12px] text-[#6f7078]">None</span>
          )}
        </PropertyRow>
        <PropertyRow label="Worktree">
          {task.execution.worktreePath ? (
            <span className="block font-mono text-[12px] text-[#d7d7dc]">{task.execution.worktreePath}</span>
          ) : (
            <span className="text-[12px] text-[#6f7078]">None</span>
          )}
        </PropertyRow>
        {task.execution.worktreeBranch ? (
          <PropertyRow label="Worktree branch">
            <span className="font-mono text-[12px] text-[#d7d7dc]">{task.execution.worktreeBranch}</span>
          </PropertyRow>
        ) : null}
        {task.execution.worktreeState ? (
          <PropertyRow label="Worktree state">
            <span className="text-[12px] text-[#d7d7dc]">{task.execution.worktreeState}</span>
          </PropertyRow>
        ) : null}

        {task.execution.attempts.length > 0 ? (
          <Section title={`Attempts (${task.execution.attempts.length})`}>
            <ol className="space-y-3">
              {[...task.execution.attempts]
                .reverse()
                .map((attempt, indexFromLatest) => {
                  const isLatest = indexFromLatest === 0
                  const status = inferAttemptStatus(attempt, isLatest, executionStatus)
                  return (
                    <AttemptRow
                      key={attempt.id}
                      attempt={attempt}
                      status={status}
                    />
                  )
                })}
            </ol>
          </Section>
        ) : null}

        <Section title="Description">
          {task.description.trim() ? (
            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-6 text-[#d7d7dc]">{task.description}</pre>
          ) : (
            <div className="text-[12px] text-[#6f7078]">No description.</div>
          )}
        </Section>

        <Section title="Evidence">
          <EvidenceRow label="Summary" value={task.evidence.summary} />
          <EvidenceList label="Touched files" items={task.evidence.touchedFiles} />
          <EvidenceList label="Commands" items={task.evidence.commandsRun} />
          <EvidenceList label="Artifacts" items={task.evidence.artifacts} />
        </Section>

        <Section title={`Activity (${task.comments.length})`}>
          {task.comments.length === 0 ? (
            <div className="text-[12px] text-[#6f7078]">No comments yet.</div>
          ) : (
            <ul className="space-y-3">
              {task.comments.map((comment) => (
                <li key={comment.id} className="border-l border-[#2a2b31] pl-3">
                  <div className="flex items-baseline gap-2 text-[11.5px] text-[#9a9aa2]">
                    <span className="font-medium text-[#d7d7dc]">{comment.author.name ?? comment.author.type}</span>
                    <span className="text-[#6f7078]">·</span>
                    <span className="uppercase tracking-[0.06em] text-[#6f7078]">{comment.kind}</span>
                    <span className="text-[#6f7078]">·</span>
                    <span className="tabular-nums">{formatRelativeTime(comment.createdAt)}</span>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap font-sans text-[13px] leading-6 text-[#d7d7dc]">{comment.body}</pre>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <footer className="border-t border-[#1f2025] px-5 py-3">
        <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">
          Add comment
        </label>
        <div className="mt-2 flex gap-2">
          <textarea
            value={commentBody}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Plan, ask, or note an enrichment for the next claimer..."
            rows={2}
            className="min-h-[44px] flex-1 rounded border border-[#2a2b31] bg-[#0d0e11] p-2 text-[13px] leading-6 text-[#ececee] outline-none focus:border-[#ececee]/40"
          />
          <button
            type="button"
            onClick={onAddComment}
            disabled={busy || !commentBody.trim()}
            className="h-9 self-end rounded border border-[#2a2b31] px-3 text-[12px] font-semibold text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
          >
            Comment
          </button>
        </div>
      </footer>
    </div>
  )
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 border-b border-[#16171b] py-1.5">
      <div className="text-[11px] uppercase tracking-[0.08em] text-[#6f7078]">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-[#1f2025] pt-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">{title}</div>
      {children}
    </div>
  )
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-3 py-1">
      <div className="text-[11px] uppercase tracking-[0.08em] text-[#6f7078]">{label}</div>
      <div className="min-w-0 text-[12.5px] leading-5 text-[#d7d7dc]">
        {value.trim() ? value : <span className="text-[#6f7078]">—</span>}
      </div>
    </div>
  )
}

function EvidenceList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-3 py-1">
      <div className="text-[11px] uppercase tracking-[0.08em] text-[#6f7078]">{label}</div>
      <div className="min-w-0">
        {items.length === 0 ? (
          <span className="text-[12px] text-[#6f7078]">—</span>
        ) : (
          <ul className="space-y-0.5 font-mono text-[11.5px] text-[#d7d7dc]">
            {items.map((item, idx) => (
              <li key={`${label}-${idx}`} className="truncate">{item}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function executionTitle(record: SwitchboardTaskRecord): string {
  const execution = record.task.execution
  return [
    execution.activeExecutionId ? `Execution ${execution.activeExecutionId}` : null,
    execution.activeProvider ? `Provider ${execution.activeProvider}` : null,
    execution.activeSessionId ? `Session ${execution.activeSessionId}` : null,
  ].filter(Boolean).join(' · ')
}

function CreateTaskDialog({
  draft,
  onChange,
  onClose,
  onSubmit,
  busy,
}: {
  draft: DraftTask
  onChange: (next: DraftTask) => void
  onClose: () => void
  onSubmit: () => void
  busy: boolean
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="absolute inset-0 z-40 flex items-center justify-center bg-[#08090b]/80"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="w-[min(540px,92vw)] rounded-md border border-[#2a2b31] bg-[#0d0e11] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#efe5ff]">New Switchboard task</h3>
          <button
            type="button"
            onClick={onClose}
            className="h-7 rounded border border-[#2a2b31] px-2 text-[11px] text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee]"
          >
            Close
          </button>
        </div>
        <label className="block">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[#8a8a92]">Title</span>
          <input
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
            placeholder="What needs to happen?"
            className="mt-1 block w-full rounded border border-[#2a2b31] bg-[#08090b] p-2 text-[13px] text-[#ececee] outline-none focus:border-[#ececee]/40"
            autoFocus
          />
        </label>
        <label className="mt-3 block">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[#8a8a92]">Description</span>
          <textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            rows={4}
            placeholder="Context, intent, links, and acceptance criteria."
            className="mt-1 block w-full rounded border border-[#2a2b31] bg-[#08090b] p-2 text-[13px] leading-6 text-[#ececee] outline-none focus:border-[#ececee]/40"
          />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[#8a8a92]">Priority</span>
            <select
              value={draft.priority == null ? '' : String(draft.priority)}
              onChange={(event) => {
                const v = event.target.value
                onChange({ ...draft, priority: v === '' ? null : Number(v) })
              }}
              className="mt-1 h-9 w-full rounded border border-[#2a2b31] bg-[#08090b] px-2 text-[13px] text-[#ececee]"
            >
              <option value="">No priority</option>
              <option value="0">Urgent</option>
              <option value="1">High</option>
              <option value="2">Medium</option>
              <option value="3">Low</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[#8a8a92]">Identifier</span>
            <input
              value={draft.identifier}
              onChange={(event) => onChange({ ...draft, identifier: event.target.value })}
              placeholder="ENG-123"
              className="mt-1 h-9 w-full rounded border border-[#2a2b31] bg-[#08090b] px-2 text-[13px] text-[#ececee]"
            />
          </label>
        </div>
        <label className="mt-3 block">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[#8a8a92]">Labels (comma separated)</span>
          <input
            value={draft.labels}
            onChange={(event) => onChange({ ...draft, labels: event.target.value })}
            placeholder="frontend, design"
            className="mt-1 h-9 w-full rounded border border-[#2a2b31] bg-[#08090b] px-2 text-[13px] text-[#ececee]"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded border border-[#2a2b31] px-3 text-[12px] font-medium text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !draft.title.trim()}
            className="h-8 rounded border border-[#3b2f63] bg-[#1a1530] px-3 text-[12px] font-semibold text-[#efe5ff] hover:bg-[#221a3a] disabled:opacity-50"
          >
            Create in Todo
          </button>
        </div>
      </div>
    </div>
  )
}

type RunnerSettings = {
  queues: SwitchboardRunnerQueue[]
  maxConcurrency: number
  provider: SwitchboardExecutionProviderKind
  cli: 'codex' | 'claude'
}

const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  queues: ['ready'],
  maxConcurrency: 2,
  provider: 'local-process',
  cli: 'codex',
}

function settingsFromState(state: SwitchboardRunnerState | null): RunnerSettings {
  if (!state) return DEFAULT_RUNNER_SETTINGS
  return {
    queues: state.queues.length > 0 ? [...state.queues] : ['ready'],
    maxConcurrency: state.maxConcurrency || 2,
    provider: state.provider,
    cli: state.cli,
  }
}

function RunnerToolbar({
  runner,
  workspaceId,
  onRefresh,
  onNotify,
}: {
  runner: SwitchboardRunner
  workspaceId: string
  onRefresh: () => Promise<void> | void
  onNotify: (tone: ToastTone, message: string) => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<RunnerSettings>(() => settingsFromState(runner.state))

  useEffect(() => {
    if (!settingsOpen) {
      setDraft(settingsFromState(runner.state))
    }
  }, [runner.state, settingsOpen])

  const isStarted = runner.status === 'running' || runner.status === 'paused'
  const canEdit = !isStarted

  const handleStart = useCallback(async () => {
    const ok = await runner.start({
      workspaceId,
      queues: draft.queues,
      maxConcurrency: draft.maxConcurrency,
      provider: draft.provider,
      cli: draft.cli,
    })
    if (ok) setSettingsOpen(false)
  }, [draft, runner, workspaceId])

  const handleStopRunner = useCallback(async () => {
    const confirmed = window.confirm('Stop the Switchboard runner for this workspace? Active executions are not stopped.')
    if (!confirmed) return
    const ok = await runner.stop()
    if (ok) {
      setSettingsOpen(false)
      await onRefresh()
      onNotify('success', 'Runner stopped.')
    } else {
      onNotify('error', 'Runner did not stop. Check the runner error message and try again.')
    }
  }, [onNotify, onRefresh, runner])

  const handleStopExecution = useCallback(
    async (execution: SwitchboardRunnerExecution) => {
      const confirmed = window.confirm(`Stop execution ${execution.executionId}? The task will remain recoverable.`)
      if (!confirmed) return
      const ok = await runner.stopExecution(execution.executionId, 'Stopped from Switchboard board.')
      if (ok) {
        await onRefresh()
        onNotify('success', 'Execution stopped.')
      } else {
        onNotify('error', 'Execution did not stop. Check the runner error message and try again.')
      }
    },
    [onNotify, onRefresh, runner]
  )

  const summaryQueues = runner.state ? runner.state.queues : draft.queues
  const queuesLabel =
    summaryQueues.length > 0 ? summaryQueues.map(runnerQueueLabel).join(' · ') : 'No queues'
  const summaryProvider = runner.state ? runner.state.provider : draft.provider
  const summaryCli = runner.state ? runner.state.cli : draft.cli
  const summaryConcurrency = runner.state ? runner.state.maxConcurrency : draft.maxConcurrency
  const allExecutions = runner.state?.activeExecutions ?? []
  const activeExecutions = allExecutions.filter(
    (execution) => !execution.status || execution.status === 'active'
  )
  const inactiveExecutions = allExecutions.filter(
    (execution) => execution.status && execution.status !== 'active'
  )
  const activeCount = activeExecutions.length
  const updatedAt = runner.state?.updatedAt
    ? formatRelativeTime(runner.state.updatedAt)
    : null

  return (
    <div className="border-b border-[#1f2025]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[#9a9aa2]">
          <RunnerStatusPill status={runner.status} />
          <ToolbarFact label="Provider" value={providerLabel(summaryProvider)} />
          <ToolbarFact label="CLI" value={summaryCli} />
          <ToolbarFact label="Concurrency" value={String(summaryConcurrency)} />
          <ToolbarFact label="Queues" value={queuesLabel} />
          <ToolbarFact label="Active" value={String(activeCount)} />
          {updatedAt ? <span className="text-[11px] text-[#6f7078]">Updated {updatedAt}</span> : null}
        </div>
        <div className="relative flex items-center gap-1.5">
          {runner.status === 'running' ? (
            <button
              type="button"
              onClick={() => void runner.pause()}
              disabled={runner.busy}
              className="h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-semibold text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
            >
              Pause
            </button>
          ) : null}
          {runner.status === 'paused' ? (
            <button
              type="button"
              onClick={() => void runner.resume()}
              disabled={runner.busy}
              className="h-7 rounded border border-[#3b2f63] bg-[#1a1530] px-2.5 text-[11px] font-semibold text-[#efe5ff] hover:bg-[#221a3a] disabled:opacity-50"
            >
              Resume
            </button>
          ) : null}
          {isStarted ? (
            <button
              type="button"
              onClick={() => void runner.tick()}
              disabled={runner.busy}
              className="h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
              title="Run one runner tick now"
            >
              Tick
            </button>
          ) : null}
          {isStarted ? (
            <button
              type="button"
              onClick={() => void handleStopRunner()}
              disabled={runner.busy}
              className="h-7 rounded border border-[#4a2527] px-2.5 text-[11px] font-semibold text-[#ffb3b5] hover:bg-[#1c1414] disabled:opacity-50"
              title="Stop the workspace runner backend"
            >
              Stop runner
            </button>
          ) : null}
          <button
            type="button"
            aria-pressed={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
            className={`h-7 rounded border px-2.5 text-[11px] font-medium transition-colors ${
              settingsOpen
                ? 'border-[#3b2f63] bg-[#1a1530] text-[#efe5ff]'
                : 'border-[#2a2b31] text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee]'
            }`}
          >
            {canEdit ? 'Configure' : 'Settings'}
          </button>
          {!isStarted ? (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={runner.busy || draft.queues.length === 0}
              className="h-7 rounded border border-[#3b2f63] bg-[#1a1530] px-2.5 text-[11px] font-semibold text-[#efe5ff] hover:bg-[#221a3a] disabled:opacity-50"
            >
              {runner.busy ? 'Starting…' : 'Start runner'}
            </button>
          ) : null}
          {settingsOpen ? (
            <RunnerSettingsPopover
              draft={draft}
              onChange={setDraft}
              canEdit={canEdit}
              onClose={() => setSettingsOpen(false)}
              onStart={handleStart}
              busy={runner.busy}
              isStarted={isStarted}
            />
          ) : null}
        </div>
      </div>
      {runner.error ? (
        <div className="border-t border-[#3a2222] bg-[#1c1414] px-3 py-1.5 text-[11.5px] text-[#ffb3b5]">
          Runner error: {runner.error}
        </div>
      ) : null}
      {activeExecutions.length > 0 ? (
        <ExecutionsSection
          title="Active executions"
          executions={activeExecutions}
          tone="active"
          busy={runner.busy}
          onStopExecution={handleStopExecution}
        />
      ) : null}
      {inactiveExecutions.length > 0 ? (
        <ExecutionsSection title="Other tracked executions" executions={inactiveExecutions} tone="inactive" />
      ) : null}
    </div>
  )
}

function RunnerStatusPill({ status }: { status: RunnerStatusKind }) {
  const map = {
    running: { dot: 'bg-[#30d158]', label: 'Running', cls: 'text-[#a8e6b3]' },
    paused: { dot: 'bg-[#f2c45f]', label: 'Paused', cls: 'text-[#f2d690]' },
    stopped: { dot: 'bg-[#5a5a63]', label: 'Stopped', cls: 'text-[#9a9aa2]' },
    unconfigured: { dot: 'bg-[#3a3b42]', label: 'Not started', cls: 'text-[#6f7078]' },
  }[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold ${map.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${map.dot}`} aria-hidden="true" />
      {map.label}
    </span>
  )
}

function ToolbarFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-[11.5px]">
      <span className="text-[#6f7078]">{label}</span>
      <span className="text-[#d7d7dc]">{value}</span>
    </span>
  )
}

function ExecutionsSection({
  title,
  executions,
  tone,
  busy = false,
  onStopExecution,
}: {
  title: string
  executions: SwitchboardRunnerExecution[]
  tone: 'active' | 'inactive'
  busy?: boolean
  onStopExecution?: (execution: SwitchboardRunnerExecution) => void
}) {
  const includeLogsNote = tone === 'active'
  return (
    <div className="border-t border-[#16171b]">
      <div className="flex items-baseline justify-between gap-3 px-3 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#6f7078]">
        <span>{title}</span>
        <span className="font-normal normal-case tracking-normal text-[#5a5a63]">{executions.length}</span>
      </div>
      <ul className="max-h-40 overflow-auto">
        {executions.map((execution) => (
          <li
            key={execution.executionId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#16171b] px-3 py-1.5 text-[11.5px]"
          >
            <span className="font-mono text-[11px] text-[#cdbcff]">{execution.taskId.slice(0, 8)}</span>
            <span className="text-[#d7d7dc]">{execution.role || 'unknown role'}</span>
            <span className="text-[#9a9aa2]">
              {runnerQueueLabel(execution.claimedFrom)} → {execution.claimedStatus.replace(/_/g, ' ')}
            </span>
            <span className="text-[#6f7078]">{providerLabel(execution.provider)}</span>
            <span className="text-[#6f7078]">started {formatRelativeTime(execution.startedAt)}</span>
            {tone === 'inactive' && execution.status ? (
              <span className="rounded border border-[#3a3426] bg-[#1d1714] px-1.5 py-0.5 text-[10.5px] text-[#f2c45f]">
                {execution.status}
              </span>
            ) : null}
            {tone === 'active' && onStopExecution ? (
              <button
                type="button"
                onClick={() => onStopExecution(execution)}
                disabled={busy}
                className="ml-auto h-6 rounded border border-[#4a2527] px-2 text-[10.5px] font-semibold text-[#ffb3b5] hover:bg-[#1c1414] disabled:opacity-50"
              >
                Stop
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {includeLogsNote ? (
        <div className="border-t border-[#16171b] px-3 py-1.5 text-[10.5px] text-[#5a5a63]">
          Live execution logs are not bridged to the renderer. Inspect Python runner output for details.
        </div>
      ) : null}
    </div>
  )
}

function RunnerSettingsPopover({
  draft,
  onChange,
  canEdit,
  onClose,
  onStart,
  busy,
  isStarted,
}: {
  draft: RunnerSettings
  onChange: (next: RunnerSettings) => void
  canEdit: boolean
  onClose: () => void
  onStart: () => void
  busy: boolean
  isStarted: boolean
}) {
  return (
    <div
      role="dialog"
      aria-label="Runner settings"
      className="absolute right-0 top-9 z-30 w-[320px] rounded-md border border-[#2a2b31] bg-[#0d0e11] p-3 shadow-[0_18px_50px_rgba(0,0,0,0.32)]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#efe5ff]">
          Runner settings
        </span>
        <button
          type="button"
          onClick={onClose}
          className="h-6 rounded border border-[#2a2b31] px-1.5 text-[10.5px] text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee]"
        >
          Close
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.08em] text-[#6f7078]">Queues</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {RUNNER_QUEUES.map((queue) => {
              const active = draft.queues.includes(queue)
              return (
                <button
                  key={queue}
                  type="button"
                  aria-pressed={active}
                  disabled={!canEdit}
                  onClick={() => {
                    const next = active
                      ? draft.queues.filter((q) => q !== queue)
                      : [...draft.queues, queue]
                    onChange({ ...draft, queues: next })
                  }}
                  className={`h-6 rounded border px-2 text-[10.5px] font-medium transition-colors ${
                    active
                      ? 'border-[#3b2f63] bg-[#1a1530] text-[#efe5ff]'
                      : 'border-[#2a2b31] text-[#9a9aa2] hover:text-[#d7d7dc]'
                  } disabled:opacity-50`}
                >
                  {runnerQueueLabel(queue)}
                </button>
              )
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[10.5px] uppercase tracking-[0.08em] text-[#6f7078]">Concurrency</span>
            <input
              type="number"
              min={1}
              max={16}
              value={draft.maxConcurrency}
              disabled={!canEdit}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10)
                if (!Number.isFinite(parsed) || parsed < 1) return
                onChange({ ...draft, maxConcurrency: Math.min(parsed, 16) })
              }}
              className="mt-1 h-7 w-full rounded border border-[#2a2b31] bg-[#08090b] px-2 text-[12px] text-[#ececee] disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="text-[10.5px] uppercase tracking-[0.08em] text-[#6f7078]">CLI</span>
            <select
              value={draft.cli}
              disabled={!canEdit}
              onChange={(event) => onChange({ ...draft, cli: event.target.value as 'codex' | 'claude' })}
              className="mt-1 h-7 w-full rounded border border-[#2a2b31] bg-[#08090b] px-1.5 text-[12px] text-[#ececee] disabled:opacity-50"
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-[10.5px] uppercase tracking-[0.08em] text-[#6f7078]">Provider</span>
          <select
            value={draft.provider}
            disabled={!canEdit}
            onChange={(event) =>
              onChange({ ...draft, provider: event.target.value as SwitchboardExecutionProviderKind })
            }
            className="mt-1 h-7 w-full rounded border border-[#2a2b31] bg-[#08090b] px-1.5 text-[12px] text-[#ececee] disabled:opacity-50"
          >
            {RUNNER_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {providerLabel(provider)}
              </option>
            ))}
          </select>
        </label>
        {!canEdit ? (
          <div className="text-[10.5px] leading-4 text-[#6f7078]">
            Runner is {isStarted ? 'started' : 'unavailable'}; settings are read-only.
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onStart}
              disabled={busy || draft.queues.length === 0}
              className="h-7 rounded border border-[#3b2f63] bg-[#1a1530] px-3 text-[11px] font-semibold text-[#efe5ff] hover:bg-[#221a3a] disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Start runner'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Banner({
  tone,
  message,
  onRetry,
}: {
  tone: 'error' | 'warning'
  message: string
  onRetry?: () => void
}) {
  const toneClass =
    tone === 'error'
      ? 'border-[#3a2222] bg-[#1c1414] text-[#ffb3b5]'
      : 'border-[#3a3426] bg-[#1d1714] text-[#f2c45f]'
  return (
    <div className={`flex items-center justify-between gap-3 border-b ${toneClass} px-3 py-2 text-[12px]`}>
      <span className="min-w-0 truncate">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded border border-current px-2 py-0.5 text-[11px] font-semibold"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}

function ToastBanner({ toast }: { toast: Toast }) {
  const cls =
    toast.tone === 'error'
      ? 'border-[#3a2222] bg-[#1c1414] text-[#ffb3b5]'
      : toast.tone === 'success'
        ? 'border-[#234d27] bg-[#0f1d10] text-[#9be39e]'
        : 'border-[#2a2b31] bg-[#111216] text-[#d7d7dc]'
  return (
    <div className={`pointer-events-none absolute bottom-3 right-3 max-w-[520px] rounded border px-3 py-1.5 text-[12px] shadow-[0_12px_30px_rgba(0,0,0,0.35)] ${cls}`}>
      {toast.message}
    </div>
  )
}
