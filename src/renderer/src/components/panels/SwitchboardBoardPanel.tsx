import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ArrowRightIcon, PlusIcon, PriorityIcon, SpecialistActionIcon, StatusIcon } from '../AppIcons'
import { focusOrAddAgentSessionTab, hasAgentTab } from '../../utils/modelRegistry'
import {
  soulRoleToSprintEngineRole,
  sprintEngineRoleLabels,
} from '../../utils/sprintengine'
import { describeExecutionTerminal, useTerminalSessions } from '../../hooks/useTerminalSessions'
import { isEditableTarget } from '../../utils/keyboard'
import { Field, Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import {
  ActionStatusChip,
  useActionFeedback,
  usePendingActions,
  type ActionStatus,
  type ActionTone,
} from '../ui/ActionFeedback'
import {
  Banner,
  BoardLane,
  BoardLaneDropIndicator,
  FOCUS_RING_CLASS,
  CloseIconButton,
  DefinitionList,
  Drawer,
  FOCUS_RING_INSET_CLASS,
  GhostButton,
  OverflowMenu,
  PanelHeader,
  PrimaryButton,
  RoleAvatar,
  Section,
  Select,
  SidePane,
  SidePaneHeader,
  Skeleton,
  StatusDot,
  TaskCard,
  Tooltip,
  TruncatedText,
  type DefinitionItem,
  type OverflowMenuItem,
  type Tone,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import {
  attentionReasonDescription,
  attentionReasonLabel,
  BOARD_STATUS_ORDER,
  deriveAttentionInfo,
  confidenceLabel,
  formatRelativeTime,
  groupTasksByStatus,
  legalMoveTargets,
  priorityLabel,
  shortIdentifier,
  sourceLabel,
  statusLabel,
  useSwitchboardData,
  type SwitchboardAttentionInfo,
} from '../../utils/switchboardBoard'
import {
  providerLabel,
  RUNNER_PROVIDERS,
  RUNNER_QUEUES,
  executionRouteLabel,
  executionSubjectLabel,
  isSwitchboardTaskExecution,
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
import type { McpSettings } from '../../types/workspace'

type PendingKey = 'create' | 'move' | 'addComment' | 'refresh' | 'retry'

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

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

const EXECUTION_TONES: Record<SwitchboardExecutionStatus, Tone> = {
  launching: 'accent',
  active: 'accent',
  abandoned: 'error',
  stale: 'warn',
  missing: 'error',
  completed: 'good',
  stopped: 'error',
}

const EXECUTION_LABELS: Record<SwitchboardExecutionStatus, string> = {
  launching: 'Launching',
  active: 'Active',
  abandoned: 'Abandoned',
  stale: 'Stale',
  missing: 'Missing',
  completed: 'Completed',
  stopped: 'Stopped',
}

const RUNNER_TONE: Record<RunnerStatusKind, Tone> = {
  running: 'good',
  paused: 'warn',
  stopped: 'neutral',
  unconfigured: 'neutral',
}

const RUNNER_LABEL: Record<RunnerStatusKind, string> = {
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  unconfigured: 'Not started',
}

const RUNNING_EXECUTION_STATUSES: ReadonlySet<SwitchboardExecutionStatus> = new Set([
  'launching',
  'active',
])

type SwitchboardRunningEntry = {
  execution: SwitchboardRunnerExecution & { kind: 'switchboard_task' }
  record: SwitchboardTaskRecord | null
}

function confidenceTone(value: number): Tone {
  if (value >= 80) return 'good'
  if (value >= 50) return 'accent'
  if (value >= 25) return 'warn'
  return 'error'
}

export default function SwitchboardBoardPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const folderPath = workspace?.folderPath ?? null
  const { state, tasks, problems, refresh } = useSwitchboardData(folderPath)
  const runner = useSwitchboardRunner(folderPath, workspaceId, mcpSettings)

  const grouped = useMemo(() => groupTasksByStatus(tasks), [tasks])
  const boardTasks = useMemo(
    () => tasks.filter((record) => record.location.folderStatus !== 'inbox'),
    [tasks]
  )
  const executionStatusByTaskId = useMemo(() => {
    const map = new Map<string, SwitchboardExecutionStatus>()
    const executions = runner.state?.activeExecutions ?? []
    for (const execution of executions) {
      if (isSwitchboardTaskExecution(execution) && execution.status) map.set(execution.taskId, execution.status)
    }
    return map
  }, [runner.state])

  const activeExecutionByTaskId = useMemo(() => {
    const map = new Map<string, SwitchboardRunnerExecution>()
    const executions = runner.state?.activeExecutions ?? []
    for (const execution of executions) {
      if (isSwitchboardTaskExecution(execution) && (!execution.status || execution.status === 'active')) {
        map.set(execution.taskId, execution)
      }
    }
    return map
  }, [runner.state])

  const runningExecutions = useMemo<SwitchboardRunningEntry[]>(() => {
    const executions = runner.state?.activeExecutions ?? []
    const taskByRecordId = new Map(tasks.map((record) => [record.task.id, record]))
    const entries: SwitchboardRunningEntry[] = []
    for (const execution of executions) {
      if (!isSwitchboardTaskExecution(execution)) continue
      const status = execution.status
      if (status && !RUNNING_EXECUTION_STATUSES.has(status)) continue
      entries.push({
        execution,
        record: taskByRecordId.get(execution.taskId) ?? null,
      })
    }
    return entries
  }, [runner.state, tasks])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [runnerOpen, setRunnerOpen] = useState(false)
  const [runningOpen, setRunningOpen] = useState(false)

  // The running-agents aside and the task-detail aside share one panel slot.
  // User-initiated task selection (board click, keyboard nav, new-task,
  // clicking a row in the running aside) switches the slot to detail by
  // closing the running aside. Programmatic resets (auto-recovery, detail X)
  // still call setSelectedId directly.
  const selectTask = useCallback((id: string | null) => {
    setSelectedId(id)
    if (id) setRunningOpen(false)
  }, [])
  const [draft, setDraft] = useState<DraftTask>(emptyDraft)
  const [commentBody, setCommentBody] = useState('')
  const [dragSource, setDragSource] = useState<{ taskId: string; from: SwitchboardFolderStatus } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ lane: SwitchboardTaskStatus; index: number } | null>(null)
  const [recentlyMovedId, setRecentlyMovedId] = useState<string | null>(null)
  const { isPending, run: runAction } = usePendingActions<PendingKey>()
  const feedback = useActionFeedback()

  useEffect(() => {
    if (!recentlyMovedId) return
    const handle = window.setTimeout(() => setRecentlyMovedId(null), 700)
    return () => window.clearTimeout(handle)
  }, [recentlyMovedId])

  useEffect(() => {
    if (runningExecutions.length === 0 && runningOpen) {
      setRunningOpen(false)
    }
  }, [runningExecutions.length, runningOpen])

  const dragLegalTargets = useMemo(
    () => (dragSource ? new Set<SwitchboardTaskStatus>(legalMoveTargets(dragSource.from)) : new Set<SwitchboardTaskStatus>()),
    [dragSource]
  )

  useEffect(() => {
    if (selectedId && !boardTasks.some((record) => record.task.id === selectedId)) {
      setSelectedId(boardTasks[0]?.task.id ?? null)
    }
  }, [boardTasks, selectedId])

  const selected = useMemo(
    () => boardTasks.find((record) => record.task.id === selectedId) ?? null,
    [boardTasks, selectedId]
  )

  const notifyToolbar = useCallback(
    (tone: ActionTone, message: string) => feedback.notify('runner', tone, message),
    [feedback]
  )

  const handleCreate = useCallback(async () => {
    if (!folderPath || !draft.title.trim()) return
    await runAction('create', async () => {
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
        feedback.notify('board', 'error', result.message)
        return
      }
      selectTask(result.record.task.id)
      setDraft(emptyDraft)
      setCreateOpen(false)
      await refresh()
      feedback.notify('board', 'success', 'Task added to Todo.')
    })
  }, [draft, feedback, folderPath, refresh, runAction])

  const handleMove = useCallback(
    async (record: SwitchboardTaskRecord, to: SwitchboardTaskStatus) => {
      if (!folderPath) return
      await runAction('move', async () => {
        const result = await window.api.moveSwitchboardTask({
          workspaceRoot: folderPath,
          id: record.task.id,
          to,
        })
        if (!result.ok) {
          feedback.notify('detail', 'error', result.message)
          return
        }
        setRecentlyMovedId(record.task.id)
        await refresh()
        feedback.notify('detail', 'success', `Moved to ${statusLabel(to)}.`)
      })
    },
    [feedback, folderPath, refresh, runAction]
  )

  const handleRetry = useCallback(
    async (record: SwitchboardTaskRecord) => {
      if (!folderPath) return
      await runAction('retry', async () => {
        const result = await window.api.requeueSwitchboardTask({
          workspaceRoot: folderPath,
          id: record.task.id,
          reason: 'retry-from-attention-surface',
        })
        if (!result.ok) {
          feedback.notify('detail', 'error', result.message)
          return
        }
        setRecentlyMovedId(record.task.id)
        await refresh()
        feedback.notify('detail', 'success', 'Requeued for another attempt.')
      })
    },
    [feedback, folderPath, refresh, runAction]
  )

  const handleBoardKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (isEditableTarget(event.target)) return

      if ((event.metaKey || event.ctrlKey) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        if (!selected) return
        const currentStatus = selected.location.folderStatus
        const currentLaneIdx = BOARD_STATUS_ORDER.indexOf(currentStatus as SwitchboardTaskStatus)
        if (currentLaneIdx === -1) return
        const targets = legalMoveTargets(currentStatus)
        const targetSet = new Set(targets)
        let nextStatus: SwitchboardTaskStatus | null = null
        if (event.key === 'ArrowRight') {
          for (let i = currentLaneIdx + 1; i < BOARD_STATUS_ORDER.length; i += 1) {
            if (targetSet.has(BOARD_STATUS_ORDER[i])) {
              nextStatus = BOARD_STATUS_ORDER[i]
              break
            }
          }
        } else {
          for (let i = currentLaneIdx - 1; i >= 0; i -= 1) {
            if (targetSet.has(BOARD_STATUS_ORDER[i])) {
              nextStatus = BOARD_STATUS_ORDER[i]
              break
            }
          }
        }
        if (nextStatus) {
          event.preventDefault()
          void handleMove(selected, nextStatus)
        }
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'c') {
        event.preventDefault()
        setCreateOpen(true)
        return
      }

      const navKeys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'j', 'k', 'h', 'l']
      if (!navKeys.includes(event.key)) return
      event.preventDefault()

      const currentLaneIdx = selected
        ? BOARD_STATUS_ORDER.indexOf(selected.location.folderStatus as SwitchboardTaskStatus)
        : -1
      const currentCards = currentLaneIdx >= 0
        ? grouped[BOARD_STATUS_ORDER[currentLaneIdx]] ?? []
        : []
      const currentCardIdx = selected
        ? currentCards.findIndex((record) => record.task.id === selected.task.id)
        : -1

      const goVertical = (delta: number) => {
        if (currentLaneIdx < 0 || currentCards.length === 0) {
          for (const status of BOARD_STATUS_ORDER) {
            const cards = grouped[status] ?? []
            if (cards.length > 0) {
              selectTask(cards[0].task.id)
              return
            }
          }
          return
        }
        const next = currentCardIdx + delta
        if (next >= 0 && next < currentCards.length) {
          selectTask(currentCards[next].task.id)
        }
      }

      const goHorizontal = (delta: number) => {
        const startLane = currentLaneIdx >= 0 ? currentLaneIdx : 0
        for (
          let i = startLane + delta;
          i >= 0 && i < BOARD_STATUS_ORDER.length;
          i += delta
        ) {
          const cards = grouped[BOARD_STATUS_ORDER[i]] ?? []
          if (cards.length > 0) {
            const fallbackIdx = currentCardIdx >= 0 ? currentCardIdx : 0
            const targetIdx = Math.min(Math.max(fallbackIdx, 0), cards.length - 1)
            selectTask(cards[targetIdx].task.id)
            return
          }
        }
      }

      if (event.key === 'ArrowDown' || event.key === 'j') goVertical(1)
      else if (event.key === 'ArrowUp' || event.key === 'k') goVertical(-1)
      else if (event.key === 'ArrowRight' || event.key === 'l') goHorizontal(1)
      else if (event.key === 'ArrowLeft' || event.key === 'h') goHorizontal(-1)
    },
    [grouped, handleMove, selected]
  )

  const handleAddComment = useCallback(async () => {
    if (!folderPath || !selected || !commentBody.trim()) return
    await runAction('addComment', async () => {
      const result = await window.api.addSwitchboardComment({
        workspaceRoot: folderPath,
        id: selected.task.id,
        body: commentBody.trim(),
        author: { type: 'user', name: 'You' },
        kind: 'comment',
      })
      if (!result.ok) {
        feedback.notify('comment', 'error', result.message)
        return
      }
      setCommentBody('')
      await refresh()
      feedback.notify('comment', 'success', 'Comment added.')
    })
  }, [commentBody, feedback, folderPath, refresh, runAction, selected])

  const handleRefreshBoard = useCallback(async () => {
    await runAction('refresh', async () => {
      await refresh()
    })
  }, [refresh, runAction])

  // CommandPalette → panel-command bridge. Mirrors the overflow/settings ids.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const id = (event as CustomEvent).detail?.id
      if (typeof id !== 'string') return
      switch (id) {
        case 'switchboard.refresh.board':
          void handleRefreshBoard()
          break
        case 'switchboard.open.runner':
          setRunnerOpen(true)
          break
      }
    }
    window.addEventListener('multicode:panel-command', onCommand)
    return () => window.removeEventListener('multicode:panel-command', onCommand)
  }, [handleRefreshBoard])

  if (!workspace) {
    return (
      <div className="h-full bg-[color:var(--bg-app)] p-4 text-meta text-[color:var(--text-muted)]">
        Workspace not found.
      </div>
    )
  }

  if (!folderPath) {
    return (
      <div className="h-full bg-[color:var(--bg-app)] p-6 text-meta text-[color:var(--text-muted)]">
        Choose a workspace folder to use the Switchboard board.
      </div>
    )
  }

  const overflowItems: OverflowMenuItem[] = [
    {
      id: 'switchboard.refresh.board',
      label: isPending('refresh') ? 'Refreshing…' : 'Refresh board',
      disabled: isPending('refresh'),
      onSelect: () => void handleRefreshBoard(),
    },
    {
      id: 'switchboard.open.runner',
      label: 'Open runner',
      onSelect: () => {
        // Focus the overflow trigger before the runner Drawer mounts so the
        // primitive captures it as the restore target on close.
        document.querySelector<HTMLElement>('[aria-label="Switchboard overflow"]')?.focus()
        setRunnerOpen(true)
      },
    },
  ]

  return (
    <div className="relative flex h-full min-h-0 bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <section
        tabIndex={0}
        onKeyDown={handleBoardKeyDown}
        aria-label="Switchboard board"
        aria-labelledby="switchboard-panel-title"
        className={`flex min-w-0 flex-1 flex-col ${FOCUS_RING_INSET_CLASS}`}
      >
        <PanelHeader
          tool="switchboard"
          title="Board"
          titleId="switchboard-panel-title"
          count={boardTasks.length}
          primaryAction={
            <PrimaryButton onClick={() => setCreateOpen(true)}>
              <PlusIcon className="h-3 w-3" />
              New task
            </PrimaryButton>
          }
          overflow={<OverflowMenu ariaLabel="Switchboard overflow" items={overflowItems} />}
        />

        <BoardStatusBanner status={feedback.statuses.board ?? null} onDismiss={() => feedback.dismiss('board')} />

        {state.kind === 'error' ? <Banner tone="error" message={state.message} onRetry={refresh} /> : null}
        {problems.length > 0 ? (
          <Banner
            tone="warn"
            message={`${problems.length} task file${problems.length === 1 ? '' : 's'} could not be parsed and was skipped.`}
          />
        ) : null}
        {runningExecutions.length > 0 ? (
          <button
            type="button"
            onClick={() => setRunningOpen(true)}
            aria-label="Open running agents"
            aria-pressed={runningOpen}
            className="interactive flex items-center gap-2 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-1.5 text-left text-meta hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring"
          >
            <StatusDot tone="accent" pulse label="Agents running" />
            <span className="font-medium text-[color:var(--text-strong)]">
              {runningExecutions.length} task{runningExecutions.length === 1 ? '' : 's'} running
            </span>
            <span aria-hidden className="text-[color:var(--text-disabled)]">·</span>
            <TruncatedText
              as="span"
              className="min-w-0 flex-1 text-[color:var(--text-muted)]"
              text={runningExecutions
                .map((entry) => entry.record ? shortIdentifier(entry.record) : entry.execution.taskId)
                .join(', ')}
            />
            <span className="shrink-0 font-medium text-[color:var(--accent-primary)]">
              View
            </span>
          </button>
        ) : null}

        <div className="flex min-h-0 flex-1 gap-1.5 overflow-x-auto px-1.5 py-2">
          {state.kind === 'loading' && boardTasks.length === 0 ? (
            <BoardSkeleton />
          ) : (
            BOARD_STATUS_ORDER.map((status) => {
              const isLegalDropTarget = Boolean(dragSource) && dragLegalTargets.has(status)
              const isSourceLane = dragSource?.from === status
              return (
                <SwitchboardLane
                  key={status}
                  status={status}
                  records={grouped[status] ?? []}
                  executionStatusByTaskId={executionStatusByTaskId}
                  recentlyMovedId={recentlyMovedId}
                  selectedId={selectedId}
                  onSelect={(id) => selectTask(id)}
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

      {runningOpen && runningExecutions.length > 0 ? (
        <SwitchboardRunningAgentsAside
          entries={runningExecutions}
          workspaceId={workspaceId}
          workspaceRoot={folderPath}
          onSelectTask={(taskId) => selectTask(taskId)}
          onClose={() => setRunningOpen(false)}
        />
      ) : selected ? (
        <SidePane side="right" width="md" ariaLabel="Selected task detail">
          <BoardDetailPane
            record={selected}
            workspaceId={workspaceId}
            workspaceRoot={folderPath}
            executionStatus={executionStatusByTaskId.get(selected.task.id) ?? null}
            activeExecution={activeExecutionByTaskId.get(selected.task.id) ?? null}
            attentionInfo={deriveAttentionInfo(
              selected,
              executionStatusByTaskId.get(selected.task.id) ?? null
            )}
            commentBody={commentBody}
            onCommentChange={setCommentBody}
            onAddComment={handleAddComment}
            onMove={(to) => void handleMove(selected, to)}
            onRetry={() => void handleRetry(selected)}
            isMoving={isPending('move')}
            isCommenting={isPending('addComment')}
            isRetrying={isPending('retry')}
            detailStatus={feedback.statuses.detail ?? null}
            commentStatus={feedback.statuses.comment ?? null}
            onDismissDetailStatus={() => feedback.dismiss('detail')}
            onDismissCommentStatus={() => feedback.dismiss('comment')}
            onClose={() => setSelectedId(null)}
          />
        </SidePane>
      ) : null}

      {runnerOpen ? (
        <RunnerDrawer
          runner={runner}
          workspaceId={workspaceId}
          onRefresh={refresh}
          onNotify={notifyToolbar}
          runnerStatus={feedback.statuses.runner ?? null}
          onDismissRunnerStatus={() => feedback.dismiss('runner')}
          onClose={() => setRunnerOpen(false)}
        />
      ) : null}

      {createOpen ? (
        <CreateTaskDialog
          draft={draft}
          onChange={setDraft}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
          busy={isPending('create')}
        />
      ) : null}
    </div>
  )
}

function BoardStatusBanner({
  status,
  onDismiss,
}: {
  status: ActionStatus | null
  onDismiss: () => void
}) {
  if (!status) return null
  return (
    <div className="flex items-center gap-2 border-b border-[color:var(--border-default)] px-3 py-1.5">
      <ActionStatusChip
        status={status}
        onDismiss={status.tone === 'error' ? onDismiss : undefined}
      />
    </div>
  )
}

function emptyColumnLabel(status: SwitchboardTaskStatus): string {
  switch (status) {
    case 'planning':
      return 'Nothing being planned. New tasks start here while they’re being shaped.'
    case 'todo':
      return 'No todos waiting to start.'
    case 'ready':
      return 'Nothing staged for pickup.'
    case 'in_progress':
      return 'No work in progress.'
    case 'testing':
      return 'Nothing waiting on tests.'
    case 'testing_in_progress':
      return 'No tests running right now.'
    case 'review':
      return 'Nothing waiting on review.'
    case 'review_in_progress':
      return 'No reviews running right now.'
    case 'done':
      return 'Completed work collects here.'
    case 'canceled':
      return 'No canceled tasks.'
    default:
      return 'Nothing here yet.'
  }
}

function SwitchboardLane({
  status,
  records,
  executionStatusByTaskId,
  recentlyMovedId,
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
  recentlyMovedId: string | null
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
  const laneState =
    isLegalDropTarget
      ? 'legal-drop-target'
      : dragActive && !isSourceLane
        ? 'dimmed'
        : isSourceLane
          ? 'source'
          : 'default'
  return (
    <BoardLane
      label={statusLabel(status)}
      glyph={
        <StatusIcon
          status={status}
          className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]"
        />
      }
      count={records.length}
      flipKey={records.map((record) => record.task.id).join(',')}
      state={laneState}
      dnd={
        isLegalDropTarget
          ? {
              onDragOver: onDragOverLane,
              onDragLeave: onDragLeaveLane,
              onDrop: onDropLane,
            }
          : undefined
      }
    >
      {records.length === 0 ? (
        <>
          {dropIndex === 0 ? <BoardLaneDropIndicator /> : null}
          <li className="m-1 rounded-[5px] px-2 py-3 text-micro leading-5 text-[color:var(--text-disabled)]">
            {emptyColumnLabel(status)}
          </li>
        </>
      ) : (
        records.map((record, index) => (
          <Fragment key={record.task.id}>
            {dropIndex === index ? <BoardLaneDropIndicator /> : null}
            <BoardCard
              record={record}
              executionStatus={executionStatusByTaskId.get(record.task.id) ?? null}
              selected={selectedId === record.task.id}
              justMoved={recentlyMovedId === record.task.id}
              onSelect={() => onSelect(record.task.id)}
              onDragStart={() => onCardDragStart(record)}
              onDragEnd={onCardDragEnd}
            />
            {index === records.length - 1 && dropIndex === records.length ? <BoardLaneDropIndicator /> : null}
          </Fragment>
        ))
      )}
    </BoardLane>
  )
}

function BoardCard({
  record,
  executionStatus,
  selected,
  justMoved,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  record: SwitchboardTaskRecord
  executionStatus: SwitchboardExecutionStatus | null
  selected: boolean
  justMoved: boolean
  onSelect: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const task = record.task
  const hasActiveExecutionPointer = Boolean(task.execution.activeExecutionId)
  const attentionInfo = deriveAttentionInfo(record, executionStatus)
  const effectiveStatus: SwitchboardExecutionStatus | null =
    executionStatus ?? (hasActiveExecutionPointer && !attentionInfo ? 'active' : null)

  const cardTone: Tone = attentionInfo
    ? 'warn'
    : effectiveStatus
      ? EXECUTION_TONES[effectiveStatus]
      : 'neutral'

  return (
    <TaskCard
      variant="card"
      tone={cardTone}
      identifier={shortIdentifier(record)}
      title={task.title}
      ariaLabel={`${task.title} (${statusLabel(record.location.folderStatus)})`}
      selected={selected}
      onSelect={onSelect}
      draggable
      flipKey={record.task.id}
      justMovedClassName={justMoved ? 'card-just-moved' : undefined}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', task.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      trailing={
        <PriorityIcon
          priority={task.priority}
          className="mt-0.5 h-3.5 w-3.5 text-[color:var(--text-muted)]"
        />
      }
    />
  )
}

function BoardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading board" className="flex h-full w-full gap-1.5">
      {BOARD_STATUS_ORDER.slice(0, 5).map((status, laneIdx) => (
        <section key={status} className="flex h-full min-w-[260px] flex-1 flex-col">
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-2.5">
            <Skeleton className="h-3 w-20 rounded bg-[color:var(--bg-hover)]" />
            <Skeleton className="h-3 w-5 rounded bg-[color:var(--bg-hover)]" />
          </div>
          <ol className="min-h-0 flex-1 space-y-2 px-2 py-2">
            {Array.from({ length: 3 - (laneIdx % 2) }).map((_, cardIdx) => (
              <li key={cardIdx} className="rounded-[5px] border-l-2 border-transparent px-2.5 py-1.5">
                <Skeleton className="h-3 w-[85%] rounded bg-[color:var(--bg-hover)]" />
                <Skeleton className="mt-1.5 h-2.5 w-[60%] rounded bg-[color:var(--bg-hover)]" />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

function SwitchboardRunningAgentsAside({
  entries,
  workspaceId,
  workspaceRoot,
  onSelectTask,
  onClose,
}: {
  entries: SwitchboardRunningEntry[]
  workspaceId: string
  workspaceRoot: string | null
  onSelectTask: (taskId: string) => void
  onClose: () => void
}) {
  const terminalSessions = useTerminalSessions()
  return (
    <SidePane side="right" width="sm" tone="sunken" ariaLabel="Running agents">
      <SidePaneHeader
        title="Running agents"
        count={`${entries.length} task${entries.length === 1 ? '' : 's'}`}
        onClose={onClose}
        closeLabel="Close running agents"
      />

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {entries.map((entry) => {
          // Switchboard is a non-Sprint Engine surface that runs fixed
          // specialist actions, not registry-keyed roles. `soulRoleToSprintEngineRole`
          // narrows the specialist id to a bundled `SprintEngineRole` (or
          // null), so indexing `sprintEngineRoleLabels` below is intentional
          // bundled-role compatibility — not a Sprint Engine registry path.
          const role = soulRoleToSprintEngineRole(entry.execution.role)
          const identifier = entry.record ? shortIdentifier(entry.record) : entry.execution.taskId
          const title = entry.record?.task.title ?? entry.execution.taskId
          const terminalState = describeExecutionTerminal(
            terminalSessions,
            workspaceId,
            entry.execution.executionId
          )
          const canOpenTerminal =
            terminalState.kind !== 'missing' && Boolean(workspaceRoot)
          const terminalTabOpen =
            terminalState.kind !== 'missing'
              ? hasAgentTab(workspaceId, terminalState.agentId)
              : false
          const terminalButtonLabel = terminalTabOpen ? 'Focus' : 'Terminal'
          const handleOpenTerminal = (): void => {
            if (!canOpenTerminal) return
            void focusOrAddAgentSessionTab(workspaceId, {
              executionId: entry.execution.executionId,
              fallbackName: role ? sprintEngineRoleLabels[role] : entry.execution.role,
            })
          }
          return (
            <li key={entry.execution.executionId} className="flex items-center gap-2 border-b border-[color:var(--border-default)] pr-3 last:border-b-0">
              <button
                type="button"
                onClick={() => onSelectTask(entry.execution.taskId)}
                aria-label={`Focus ${identifier} in board`}
                className="interactive flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[color:var(--bg-hover)] focus-visible:focus-ring-inset"
              >
                {role ? (
                  <RoleAvatar role={role} size="md" ariaLabel="" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
                  >
                    <SpecialistActionIcon icon="review" className="icon-md" />
                  </span>
                )}
                <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="shrink-0 font-mono tabular-nums text-micro text-[color:var(--text-muted)]">
                    {identifier}
                  </span>
                  <TruncatedText
                    as="span"
                    className="min-w-0 flex-1 text-body font-medium text-[color:var(--text-strong)]"
                    text={title}
                  />
                </div>
                <StatusDot tone="accent" pulse label="Running" />
                <span className="shrink-0 text-micro tabular-nums text-[color:var(--text-muted)]">
                  {formatRelativeTime(entry.execution.startedAt)}
                </span>
              </button>
              {canOpenTerminal ? (
                <GhostButton
                  size="sm"
                  className="!h-6 shrink-0"
                  onClick={handleOpenTerminal}
                >
                  {terminalButtonLabel}
                </GhostButton>
              ) : null}
            </li>
          )
        })}
      </ul>
    </SidePane>
  )
}

function ExecutionStatusInline({ status, title }: { status: SwitchboardExecutionStatus; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-meta text-[color:var(--text-default)]" title={title}>
      <StatusDot tone={EXECUTION_TONES[status]} />
      <span>{EXECUTION_LABELS[status]}</span>
    </span>
  )
}

function AttentionStrip({
  info,
  onRetry,
  isRetrying,
}: {
  info: SwitchboardAttentionInfo
  onRetry: () => void
  isRetrying: boolean
}) {
  const attemptsLabel = info.attempts === 1 ? '1 attempt' : `${info.attempts} attempts`
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-[color:var(--border-default)] bg-[color:var(--tone-warn-soft)] px-5 py-2 text-meta leading-5 text-[color:var(--text-strong)]"
    >
      <StatusDot tone="warn" label="Needs your input" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium">Needs your input</span>
        <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
        <span className="text-[color:var(--text-muted)]">{attentionReasonLabel(info.reason)}</span>
        <span className="tabular-nums text-[color:var(--text-subtle)]">
          · {attemptsLabel}
          {info.lastAttemptAt ? ` · ${formatRelativeTime(info.lastAttemptAt)}` : ''}
        </span>
      </div>
      <Tooltip content={attentionReasonDescription(info.reason)}>
        <GhostButton
          onClick={onRetry}
          disabled={isRetrying}
        >
          {isRetrying ? 'Retrying…' : 'Retry now'}
        </GhostButton>
      </Tooltip>
    </div>
  )
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
    <li className="grid grid-cols-[12px_1fr] items-start gap-3">
      <span className="mt-1.5">
        <StatusDot tone={EXECUTION_TONES[status]} />
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <TruncatedText
            as="span"
            className="min-w-0 font-mono text-meta text-[color:var(--text-default)]"
            text={attempt.agentId ?? attempt.id}
          />
          <span className="shrink-0 text-micro text-[color:var(--text-muted)]">
            {EXECUTION_LABELS[status]}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro tabular-nums text-[color:var(--text-muted)]">
          <span>started {formatRelativeTime(attempt.startedAt)}</span>
          {attempt.completedAt ? (
            <>
              <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
              <span>ended {formatRelativeTime(attempt.completedAt)}</span>
            </>
          ) : null}
        </div>
        {attempt.worktreeBranch || attempt.worktreeState ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro text-[color:var(--text-subtle)]">
            {attempt.worktreeBranch ? (
              <span className="font-mono text-[color:var(--text-muted)]">{attempt.worktreeBranch}</span>
            ) : null}
            {attempt.worktreeBranch && attempt.worktreeState ? <span>·</span> : null}
            {attempt.worktreeState ? <span>{attempt.worktreeState}</span> : null}
          </div>
        ) : null}
        {attempt.summary ? (
          <div className="text-meta leading-5 text-[color:var(--text-muted)]">{attempt.summary}</div>
        ) : null}
      </div>
    </li>
  )
}

function BoardDetailPane({
  record,
  workspaceId,
  workspaceRoot,
  executionStatus,
  activeExecution,
  attentionInfo,
  commentBody,
  onCommentChange,
  onAddComment,
  onMove,
  onRetry,
  isMoving,
  isCommenting,
  isRetrying,
  detailStatus,
  commentStatus,
  onDismissDetailStatus,
  onDismissCommentStatus,
  onClose,
}: {
  record: SwitchboardTaskRecord
  workspaceId: string
  workspaceRoot: string | null
  executionStatus: SwitchboardExecutionStatus | null
  activeExecution: SwitchboardRunnerExecution | null
  attentionInfo: SwitchboardAttentionInfo | null
  commentBody: string
  onCommentChange: (next: string) => void
  onAddComment: () => void
  onMove: (to: SwitchboardTaskStatus) => void
  onRetry: () => void
  isMoving: boolean
  isCommenting: boolean
  isRetrying: boolean
  detailStatus: ActionStatus | null
  commentStatus: ActionStatus | null
  onDismissDetailStatus: () => void
  onDismissCommentStatus: () => void
  onClose: () => void
}) {
  const task = record.task
  const targets = legalMoveTargets(record.location.folderStatus)
  const terminalSessions = useTerminalSessions()
  const terminalState = describeExecutionTerminal(
    terminalSessions,
    workspaceId,
    activeExecution?.executionId
  )
  const canOpenTerminal =
    terminalState.kind !== 'missing' && Boolean(workspaceRoot) && Boolean(activeExecution?.executionId)
  const terminalTabOpen =
    terminalState.kind !== 'missing' ? hasAgentTab(workspaceId, terminalState.agentId) : false
  const terminalButtonLabel = terminalTabOpen ? 'Focus terminal' : 'Open terminal'
  const handleOpenTerminal = (): void => {
    if (!canOpenTerminal || !activeExecution) return
    void import('../../utils/modelRegistry').then(({ focusOrAddAgentSessionTab }) => {
      void focusOrAddAgentSessionTab(workspaceId, {
        executionId: activeExecution.executionId,
        fallbackName: task.title,
      })
    })
  }

  const properties: DefinitionItem[] = useMemo(() => {
    const items: DefinitionItem[] = []
    items.push({
      term: 'Identifier',
      description: (
        <span className="font-mono text-meta text-[color:var(--text-strong)]">{task.identifier}</span>
      ),
    })
    items.push({
      term: 'Status',
      description: (
        <span className="flex items-center gap-2">
          <StatusIcon status={record.location.folderStatus} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
          {statusLabel(record.location.folderStatus)}
        </span>
      ),
    })
    items.push({
      term: 'Owner',
      description: (
        <span className="text-[color:var(--text-strong)]">
          {task.claim?.owner ?? 'Unassigned'}
        </span>
      ),
    })
    items.push({
      term: 'Priority',
      description: (
        <span className="flex items-center gap-2">
          <PriorityIcon priority={task.priority} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
          {priorityLabel(task.priority)}
        </span>
      ),
    })
    items.push({
      term: 'Source',
      description: <span>{sourceLabel(record)}</span>,
    })
    if (typeof task.creationConfidencePct === 'number') {
      items.push({
        term: 'Legitimacy',
        description: <ConfidenceInline value={task.creationConfidencePct} />,
      })
    }
    items.push({
      term: 'Opened',
      description: <span className="tabular-nums">{formatRelativeTime(task.createdAt)}</span>,
    })
    items.push({
      term: 'Last move',
      description: <span className="tabular-nums">{formatRelativeTime(task.updatedAt)}</span>,
    })
    if (task.url) {
      items.push({
        term: 'Link',
        description: (
          <TruncatedText as="span" className="text-[color:var(--accent-primary)]" text={task.url} />
        ),
      })
    }
    if (task.execution.activeExecutionId || executionStatus) {
      items.push({
        term: 'Execution',
        description: (
          <span className="block space-y-1">
            <span className="flex items-center gap-2">
              {executionStatus ? (
                <ExecutionStatusInline status={executionStatus} />
              ) : task.execution.activeExecutionId ? (
                <ExecutionStatusInline status="active" />
              ) : null}
              {task.execution.activeExecutionId ? (
                <TruncatedText as="span" className="font-mono text-[color:var(--text-muted)]" text={task.execution.activeExecutionId} />
              ) : null}
            </span>
            {task.execution.activeProvider || task.execution.activeSessionId ? (
              <span className="block text-[color:var(--text-muted)]">
                {task.execution.activeProvider ?? 'unknown provider'}
                {task.execution.activeSessionId ? ` · session ${task.execution.activeSessionId}` : ''}
              </span>
            ) : null}
          </span>
        ),
      })
    }
    if (task.execution.worktreePath) {
      items.push({
        term: 'Worktree',
        description: (
          <span className="block font-mono text-meta text-[color:var(--text-strong)]">{task.execution.worktreePath}</span>
        ),
      })
    }
    if (task.execution.worktreeBranch) {
      items.push({
        term: 'Branch',
        description: (
          <span className="font-mono text-meta text-[color:var(--text-strong)]">{task.execution.worktreeBranch}</span>
        ),
      })
    }
    if (task.execution.worktreeState) {
      items.push({
        term: 'Worktree state',
        description: <span>{task.execution.worktreeState}</span>,
      })
    }
    if (task.labels.length > 0) {
      items.push({
        term: 'Labels',
        description: <span>{task.labels.join(', ')}</span>,
      })
    }
    return items
  }, [executionStatus, record, task])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[color:var(--border-default)] px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-micro text-[color:var(--text-muted)]">
              <span className="font-mono tabular-nums text-meta text-[color:var(--text-default)]">
                {shortIdentifier(record)}
              </span>
              <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
              <span className="flex items-center gap-1.5">
                <StatusIcon status={record.location.folderStatus} className="h-3 w-3 text-[color:var(--text-muted)]" />
                {statusLabel(record.location.folderStatus)}
              </span>
              <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
              <span className="tabular-nums">{formatRelativeTime(task.updatedAt)}</span>
              <ActionStatusChip
                status={detailStatus}
                onDismiss={detailStatus?.tone === 'error' ? onDismissDetailStatus : undefined}
                className="ml-auto"
              />
            </div>
            <h3 className="mt-2 text-title font-semibold leading-6 text-[color:var(--text-strong)]">{task.title}</h3>
          </div>
          <CloseIconButton onClick={onClose} aria-label="Close task detail" />
        </div>
        {canOpenTerminal || targets.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Task actions">
            {canOpenTerminal ? (
              <Tooltip content={terminalButtonLabel}>
                <PrimaryButton onClick={handleOpenTerminal}>
                  {terminalState.kind === 'running' ? (
                    <StatusDot tone="good" pulse />
                  ) : terminalState.kind === 'exited' ? (
                    <StatusDot tone="neutral" />
                  ) : null}
                  {terminalButtonLabel}
                </PrimaryButton>
              </Tooltip>
            ) : null}
            {targets.map((target) => (
              <GhostButton
                key={target}
                onClick={() => onMove(target)}
                disabled={isMoving}
              >
                {target === 'canceled' ? (
                  'Cancel'
                ) : (
                  <>
                    <ArrowRightIcon className="h-3 w-3" />
                    {statusLabel(target)}
                  </>
                )}
              </GhostButton>
            ))}
          </div>
        ) : null}
      </header>

      {record.warnings.length > 0 ? (
        <div className="border-b border-[color:var(--border-default)] bg-[color:var(--tone-warn-soft)] px-5 py-2 text-meta leading-5 text-[color:var(--text-strong)]">
          {record.warnings.map((warning, idx) => (
            <div key={idx}>{warning}</div>
          ))}
        </div>
      ) : null}

      {attentionInfo ? (
        <AttentionStrip
          info={attentionInfo}
          onRetry={onRetry}
          isRetrying={isRetrying}
        />
      ) : null}

      <div className="flex-1 overflow-auto">
        <Section title="Properties">
          <DefinitionList items={properties} />
        </Section>

        {task.execution.attempts.length > 0 ? (
          <Section title="Attempts" count={task.execution.attempts.length}>
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
            <div className="whitespace-pre-wrap text-body leading-6 text-[color:var(--text-default)]">{task.description}</div>
          ) : (
            <div className="text-meta text-[color:var(--text-subtle)]">No description.</div>
          )}
        </Section>

        <Section title="Evidence">
          <DefinitionList
            items={[
              {
                term: 'Summary',
                description: task.evidence.summary.trim() ? (
                  <span>{task.evidence.summary}</span>
                ) : (
                  <span className="text-[color:var(--text-subtle)]">—</span>
                ),
              },
              {
                term: 'Touched files',
                description: <EvidenceItems items={task.evidence.touchedFiles} mono />,
              },
              {
                term: 'Commands',
                description: <EvidenceItems items={task.evidence.commandsRun} mono />,
              },
              {
                term: 'Artifacts',
                description: <EvidenceItems items={task.evidence.artifacts} mono />,
              },
            ]}
          />
        </Section>

        <Section title="Activity" count={task.comments.length}>
          {task.comments.length === 0 ? (
            <div className="text-meta text-[color:var(--text-subtle)]">No comments yet.</div>
          ) : (
            <ul className="space-y-3">
              {task.comments.map((comment) => (
                <li key={comment.id} className="border-l border-[color:var(--border-default)] pl-3">
                  <div className="flex items-baseline gap-2 text-meta text-[color:var(--text-muted)]">
                    <span className="font-medium text-[color:var(--text-strong)]">
                      {comment.author.name ?? comment.author.type}
                    </span>
                    <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
                    <span>{comment.kind}</span>
                    {typeof comment.confidencePct === 'number' ? (
                      <>
                        <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
                        <ConfidenceInline value={comment.confidencePct} compact />
                      </>
                    ) : null}
                    <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
                    <span className="tabular-nums">{formatRelativeTime(comment.createdAt)}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-body leading-6 text-[color:var(--text-default)]">{comment.body}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <footer className="border-t border-[color:var(--border-default)] px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="switchboard-comment-input"
            className="block text-micro font-medium text-[color:var(--text-muted)]"
          >
            Add comment
          </label>
          <ActionStatusChip
            status={commentStatus}
            onDismiss={commentStatus?.tone === 'error' ? onDismissCommentStatus : undefined}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <textarea
            id="switchboard-comment-input"
            value={commentBody}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Plan, ask, or note an enrichment for the next claimer..."
            rows={2}
            className={`min-h-[44px] flex-1 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-2 text-body leading-6 text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          />
          <PrimaryButton
            size="md"
            onClick={onAddComment}
            disabled={isCommenting || !commentBody.trim()}
            className="self-end"
          >
            {isCommenting ? 'Sending…' : 'Comment'}
          </PrimaryButton>
        </div>
      </footer>
    </div>
  )
}

function EvidenceItems({ items, mono = false }: { items: string[]; mono?: boolean }) {
  if (items.length === 0) {
    return <span className="text-[color:var(--text-subtle)]">—</span>
  }
  return (
    <ul className={`space-y-0.5 ${mono ? 'font-mono text-meta' : 'text-meta'} text-[color:var(--text-strong)]`}>
      {items.map((item, idx) => (
        <li key={`${item}-${idx}`} className="truncate">{item}</li>
      ))}
    </ul>
  )
}

function ConfidenceInline({ value, compact = false }: { value: number; compact?: boolean }) {
  const tone = confidenceTone(value)
  const label = confidenceLabel(value)
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 ${compact ? 'text-micro' : 'text-meta'} text-[color:var(--text-default)]`}
      aria-label={`Legitimacy confidence: ${label}`}
    >
      <StatusDot tone={tone} />
      <span className="tabular-nums">{compact ? `${value}%` : label}</span>
    </span>
  )
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
  const inputClass =
    'block w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-body ' +
  `text-[color:var(--text-strong)] transition-colors placeholder:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`
  return (
    <Modal open onClose={onClose} contained labelledBy="switchboard-create-title" width={540}>
      <ModalHeader title="New Switchboard task" titleId="switchboard-create-title" onClose={onClose} />
      <ModalBody className="space-y-3">
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
            placeholder="What needs to happen?"
            className={inputClass}
            autoFocus
          />
        </Field>
        <Field label="Description">
          <textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            rows={4}
            placeholder="Context, intent, links, and acceptance criteria."
            className={`${inputClass} resize-y leading-6`}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select<string>
              ariaLabel="Task priority"
              items={[
                { value: '', label: 'No priority' },
                { value: '0', label: 'Urgent' },
                { value: '1', label: 'High' },
                { value: '2', label: 'Medium' },
                { value: '3', label: 'Low' },
              ]}
              value={draft.priority == null ? '' : String(draft.priority)}
              onChange={(value) => onChange({ ...draft, priority: value === '' ? null : Number(value) })}
            />
          </Field>
          <Field label="Identifier">
            <input
              value={draft.identifier}
              onChange={(event) => onChange({ ...draft, identifier: event.target.value })}
              placeholder="ENG-123"
              className={`${inputClass} h-9 py-0`}
            />
          </Field>
        </div>
        <Field label="Labels (comma separated)">
          <input
            value={draft.labels}
            onChange={(event) => onChange({ ...draft, labels: event.target.value })}
            placeholder="frontend, design"
            className={`${inputClass} h-9 py-0`}
          />
        </Field>
      </ModalBody>
      <ModalFooter>
        <ModalButton onClick={onClose}>Cancel</ModalButton>
        <ModalButton
          variant="primary"
          onClick={onSubmit}
          disabled={busy || !draft.title.trim()}
        >
          Create in Todo
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}

type RunnerSettings = {
  queues: SwitchboardRunnerQueue[]
  maxConcurrency: number
  provider: SwitchboardExecutionProviderKind
  cli: 'codex' | 'claude-code'
}

const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  queues: ['ready'],
  maxConcurrency: 2,
  provider: 'electron-session',
  cli: 'claude-code',
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

function RunnerDrawer({
  runner,
  workspaceId,
  onRefresh,
  onNotify,
  runnerStatus,
  onDismissRunnerStatus,
  onClose,
}: {
  runner: SwitchboardRunner
  workspaceId: string
  onRefresh: () => Promise<void> | void
  onNotify: (tone: ActionTone, message: string) => void
  runnerStatus: ActionStatus | null
  onDismissRunnerStatus: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<RunnerSettings>(() => settingsFromState(runner.state))
  const dialog = useConfirmDialog()

  useEffect(() => {
    setDraft(settingsFromState(runner.state))
  }, [runner.state])

  const isStarted = runner.status === 'running' || runner.status === 'paused'
  const canEdit = !isStarted

  const handleStart = useCallback(async () => {
    await runner.start({
      workspaceId,
      queues: draft.queues,
      maxConcurrency: draft.maxConcurrency,
      provider: draft.provider,
      cli: draft.cli,
    })
  }, [draft, runner, workspaceId])

  const handleStopRunner = useCallback(async () => {
    const confirmed = await dialog.confirm({
      title: 'Stop Switchboard runner?',
      body: 'This stops the runner for this workspace and stops every active Switchboard execution. Tasks remain recoverable.',
      confirmLabel: 'Stop runner',
      tone: 'danger',
    })
    if (!confirmed) return
    const ok = await runner.stop()
    if (ok) {
      await onRefresh()
      onNotify('success', 'Runner and active executions stopped.')
    } else {
      onNotify('error', 'Runner did not stop. Check the runner error message and try again.')
    }
  }, [dialog, onNotify, onRefresh, runner])

  const handleStopExecution = useCallback(
    async (execution: SwitchboardRunnerExecution) => {
      const confirmed = await dialog.confirm({
        title: 'Stop execution?',
        body: (
          <>
            Stop execution <span className="font-mono">{execution.executionId}</span>? The task remains recoverable.
          </>
        ),
        confirmLabel: 'Stop execution',
        tone: 'danger',
      })
      if (!confirmed) return
      const ok = await runner.stopExecution(execution.executionId, 'Stopped from Switchboard board.')
      if (ok) {
        await onRefresh()
        onNotify('success', 'Execution stopped.')
      } else {
        onNotify('error', 'Execution did not stop. Check the runner error message and try again.')
      }
    },
    [dialog, onNotify, onRefresh, runner]
  )

  const allExecutions = runner.state?.activeExecutions ?? []
  const activeExecutions = allExecutions.filter(
    (execution) => !execution.status || execution.status === 'active'
  )
  const inactiveExecutions = allExecutions.filter(
    (execution) => execution.status && execution.status !== 'active'
  )
  const updatedAt = runner.state?.updatedAt ? formatRelativeTime(runner.state.updatedAt) : null
  const queuesLabel =
    draft.queues.length > 0 ? draft.queues.map(runnerQueueLabel).join(', ') : 'No queues'

  const stateItems: DefinitionItem[] = [
    {
      term: 'Status',
      description: (
        <span className="flex items-center gap-2">
          <StatusDot tone={RUNNER_TONE[runner.status]} pulse={runner.status === 'running'} />
          {RUNNER_LABEL[runner.status]}
        </span>
      ),
    },
    { term: 'Provider', description: providerLabel(draft.provider) },
    { term: 'CLI', description: draft.cli },
    { term: 'Concurrency', description: String(draft.maxConcurrency) },
    { term: 'Queues', description: queuesLabel },
    { term: 'Active executions', description: String(activeExecutions.length) },
    ...(updatedAt ? [{ term: 'Updated', description: updatedAt }] : []),
  ]

  return (
    <Drawer open onClose={onClose} title="Runner" ariaLabel="Switchboard runner" width={420}>
      <Drawer.Body className="!p-0">
        {runnerStatus ? (
          <div className="border-b border-[color:var(--border-default)] px-3 py-2">
            <ActionStatusChip
              status={runnerStatus}
              onDismiss={runnerStatus.tone === 'error' ? onDismissRunnerStatus : undefined}
            />
          </div>
        ) : null}
        <Section title="State">
          <DefinitionList items={stateItems} />
        </Section>

        <Section title="Controls">
          <div className="flex flex-wrap gap-1.5">
            {!isStarted ? (
              <PrimaryButton
                onClick={() => void handleStart()}
                disabled={runner.busy || draft.queues.length === 0}
              >
                {runner.busy ? 'Starting…' : 'Start runner'}
              </PrimaryButton>
            ) : null}
            {runner.status === 'running' ? (
              <GhostButton onClick={() => void runner.pause()} disabled={runner.busy}>
                Pause
              </GhostButton>
            ) : null}
            {runner.status === 'paused' ? (
              <PrimaryButton onClick={() => void runner.resume()} disabled={runner.busy}>
                Resume
              </PrimaryButton>
            ) : null}
            {isStarted ? (
              <Tooltip content="Run one runner tick now">
                <GhostButton
                  onClick={() => void runner.tick()}
                  disabled={runner.busy}
                >
                  Tick
                </GhostButton>
              </Tooltip>
            ) : null}
            {isStarted ? (
              <Tooltip content="Stop the workspace runner and active executions">
                <GhostButton
                  onClick={() => void handleStopRunner()}
                  disabled={runner.busy}
                >
                  Stop runner
                </GhostButton>
              </Tooltip>
            ) : null}
          </div>
        </Section>

        <Section title="Configuration">
          <RunnerSettingsFields draft={draft} onChange={setDraft} canEdit={canEdit} />
          {!canEdit ? (
            <p className="mt-2 text-micro leading-4 text-[color:var(--text-muted)]">
              Runner is {isStarted ? 'started' : 'unavailable'}; configuration is read-only until stopped.
            </p>
          ) : null}
        </Section>

        {runner.error ? (
          <Section title="Last error">
            <div className="rounded-[5px] border border-[color:var(--tone-error-soft)] bg-[color:var(--tone-error-soft)] px-3 py-2 text-meta text-[color:var(--text-strong)]">
              {runner.error}
            </div>
          </Section>
        ) : null}

        {activeExecutions.length > 0 ? (
          <Section title="Active executions" count={activeExecutions.length}>
            <ExecutionsList
              executions={activeExecutions}
              tone="active"
              busy={runner.busy}
              onStopExecution={handleStopExecution}
            />
          </Section>
        ) : null}

        {inactiveExecutions.length > 0 ? (
          <Section title="Other tracked executions" count={inactiveExecutions.length}>
            <ExecutionsList executions={inactiveExecutions} tone="inactive" />
          </Section>
        ) : null}
      </Drawer.Body>
    </Drawer>
  )
}

function RunnerSettingsFields({
  draft,
  onChange,
  canEdit,
}: {
  draft: RunnerSettings
  onChange: (next: RunnerSettings) => void
  canEdit: boolean
}) {
  const selectClass =
    'h-7 w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-1.5 text-meta text-[color:var(--text-strong)] disabled:opacity-50'
  return (
    <div className="space-y-3">
      <div>
        <div className="text-micro text-[color:var(--text-muted)]">Queues</div>
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
                className={`interactive h-6 rounded-[5px] border px-2 text-micro font-medium focus-visible:focus-ring ${
                  active
                    ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                    : 'border-[color:var(--border-default)] text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
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
          <span className="text-micro text-[color:var(--text-muted)]">Concurrency</span>
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
            className={`mt-1 ${selectClass}`}
          />
        </label>
        <label className="block">
          <span className="text-micro text-[color:var(--text-muted)]">CLI</span>
          <div className="mt-1">
            <Select<'codex' | 'claude-code'>
              ariaLabel="Runner CLI"
              items={[
                { value: 'codex', label: 'Codex' },
                { value: 'claude-code', label: 'Claude Code' },
              ]}
              value={draft.cli}
              disabled={!canEdit}
              onChange={(value) => onChange({ ...draft, cli: value })}
            />
          </div>
        </label>
      </div>
      <label className="block">
        <span className="text-micro text-[color:var(--text-muted)]">Provider</span>
        <div className="mt-1">
          <Select<SwitchboardExecutionProviderKind>
            ariaLabel="Execution provider"
            items={RUNNER_PROVIDERS.map((provider) => ({ value: provider, label: providerLabel(provider) }))}
            value={draft.provider}
            disabled={!canEdit}
            onChange={(value) => onChange({ ...draft, provider: value })}
          />
        </div>
      </label>
    </div>
  )
}

function ExecutionsList({
  executions,
  tone,
  busy = false,
  onStopExecution,
}: {
  executions: SwitchboardRunnerExecution[]
  tone: 'active' | 'inactive'
  busy?: boolean
  onStopExecution?: (execution: SwitchboardRunnerExecution) => void
}) {
  return (
    <ul className="divide-y divide-[color:var(--border-default)]">
      {executions.map((execution) => (
        <li
          key={execution.executionId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-meta"
        >
          <span className="font-mono tabular-nums text-micro text-[color:var(--text-muted)]">
            {executionSubjectLabel(execution)}
          </span>
          <span className="text-[color:var(--text-strong)]">{execution.role || 'unknown role'}</span>
          <span className="text-[color:var(--text-muted)]">{executionRouteLabel(execution)}</span>
          <span className="text-[color:var(--text-subtle)]">{providerLabel(execution.provider)}</span>
          <span className="tabular-nums text-[color:var(--text-subtle)]">started {formatRelativeTime(execution.startedAt)}</span>
          {tone === 'inactive' && execution.status ? (
            <span className="text-micro text-[color:var(--text-muted)]">{execution.status}</span>
          ) : null}
          {tone === 'active' && onStopExecution ? (
            <GhostButton
              size="sm"
              onClick={() => onStopExecution(execution)}
              disabled={busy}
              className="ml-auto"
            >
              Stop
            </GhostButton>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
