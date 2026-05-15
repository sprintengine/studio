import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Field, Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import {
  ActionStatusChip,
  useActionFeedback,
  usePendingActions,
  type ActionStatus,
} from '../ui/ActionFeedback'
import {
  WATCHTOWER_REVIEW_PRESETS,
  getWatchtowerReviewSector,
  type WatchtowerReviewPresetId,
} from '../../utils/watchtowerReview'
import { getSpecialistAction } from '../../specialists/specialistActions'
import type { McpSettings, SpecialistActionId } from '../../types/workspace'
import type {
  SwitchboardComment,
  SwitchboardTaskRecord,
  SwitchboardImportResult,
  WatchtowerRun,
  WatchtowerRunAgent,
} from '../../../../shared/switchboard'
import { CommentIcon, PriorityIcon, SpecialistActionIcon, SprintEngineRoleIcon } from '../AppIcons'
import {
  soulRoleToSprintEngineRole,
  sprintEngineRoleAccent,
  sprintEngineRoleLabels,
} from '../../utils/sprintengine'
import {
  confidenceLabel,
  confidenceToneClass,
  formatRelativeTime,
  priorityLabel,
  shortIdentifier,
  sourceLabel,
  useSwitchboardData,
} from '../../utils/switchboardBoard'
import { filterInboxTasks } from '../../utils/watchtower'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { describeExecutionTerminal, useTerminalSessions } from '../../hooks/useTerminalSessions'
import { focusOrAddFileTab, hasAgentTab } from '../../utils/modelRegistry'
import { renderMarkdown } from '../../utils/markdown'
import {
  DefinitionList,
  GhostButton,
  InboxRow,
  OverflowMenu,
  PanelHeader,
  PrimaryButton,
  Section,
  Select,
  StatusDot,
  Tooltip,
  type OverflowMenuItem,
  type Tone,
} from '../ui'

const ARCHITECT_AUTHOR_ID = 'watchtower-architect'
const INBOX_TITLE_ID = 'watchtower-inbox-title'

type FeedbackKey =
  | 'runReview'
  | 'inboxList'
  | 'fetchExternal'
  | 'detail'
  | 'comment'
type PendingKey =
  | 'startReview'
  | 'startTriageAll'
  | 'startTriageSelected'
  | 'importGitHub'
  | 'importJira'
  | 'refresh'
  | 'create'
  | 'edit'
  | 'promote'
  | 'cancelTask'
  | 'addComment'

function isEditableInboxTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

type WatchtowerStartKind = 'review' | 'triage'

type DraftTask = {
  title: string
  description: string
  priority: number | null
  labels: string
  identifier: string
}

const emptyDraft: DraftTask = {
  title: '',
  description: '',
  priority: null,
  labels: '',
  identifier: '',
}

function sanitizeIdentityPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[-._]+|[-._]+$/gu, '') || 'item'
}

function findTaskAttribution(
  record: SwitchboardTaskRecord,
  runs: WatchtowerRun[]
): { run: WatchtowerRun; agent: WatchtowerRunAgent } | null {
  if (record.task.source.type !== 'watchtower') return null
  const identities = [
    record.task.source.externalKey ?? null,
    record.task.source.externalId ?? null,
  ].filter((value): value is string => Boolean(value))
  for (const run of runs) {
    for (const identity of identities) {
      if (!identity.startsWith(`${run.runId}:`)) continue
      const remainder = identity.slice(run.runId.length + 1)
      const agent = run.agents.find((candidate) => {
        const agentIds = [candidate.agentId, sanitizeIdentityPart(candidate.agentId)]
        return agentIds.some((agentId) => remainder === agentId || remainder.startsWith(`${agentId}:`))
      })
      if (agent) return { run, agent }
    }
  }
  return null
}

function isTriageRun(run: WatchtowerRun): boolean {
  return run.preset === 'inbox_triage'
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const red = parseInt(value.slice(0, 2), 16)
  const green = parseInt(value.slice(2, 4), 16)
  const blue = parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

export type AgentTaskOutcome = {
  count: number
  total?: number
}

function countAgentOutcomes(
  run: WatchtowerRun,
  tasks: SwitchboardTaskRecord[]
): Map<string, AgentTaskOutcome> {
  const counts = new Map<string, AgentTaskOutcome>()
  const triage = isTriageRun(run)
  for (const agent of run.agents) {
    counts.set(agent.agentId, { count: 0, total: triage ? (agent.taskIds?.length ?? 0) : undefined })
  }
  if (triage) {
    const taskById = new Map(tasks.map((record) => [record.task.id, record]))
    const runStart = Date.parse(run.createdAt)
    for (const agent of run.agents) {
      const scoped = agent.taskIds ?? []
      let triaged = 0
      for (const taskId of scoped) {
        const record = taskById.get(taskId)
        if (!record) continue
        const hasTriage = record.task.comments.some((comment) => {
          if (comment.kind !== 'triage') return false
          if (comment.author.type !== 'agent') return false
          if (comment.author.id !== ARCHITECT_AUTHOR_ID) return false
          if (!Number.isFinite(runStart)) return true
          const at = Date.parse(comment.createdAt)
          return Number.isFinite(at) ? at >= runStart : true
        })
        if (hasTriage) triaged += 1
      }
      counts.set(agent.agentId, { count: triaged, total: scoped.length })
    }
    return counts
  }
  for (const record of tasks) {
    const attribution = findTaskAttribution(record, [run])
    if (!attribution) continue
    const current = counts.get(attribution.agent.agentId) ?? { count: 0 }
    counts.set(attribution.agent.agentId, { count: current.count + 1, total: current.total })
  }
  return counts
}

type TriageImportance = 'critical' | 'high' | 'medium' | 'low' | null

function latestTriageComment(record: SwitchboardTaskRecord): SwitchboardComment | null {
  for (let index = record.task.comments.length - 1; index >= 0; index -= 1) {
    const comment = record.task.comments[index]
    if (comment.kind === 'triage') return comment
  }
  return null
}

function parseTriageImportance(comment: SwitchboardComment | null): TriageImportance {
  if (!comment) return null
  const match = comment.body.match(/^Importance:\s*(Critical|High|Medium|Low)\s*$/imu)
  return match ? match[1].toLowerCase() as TriageImportance : null
}

function watchtowerStartErrorMessage(message: string): string {
  return message
}

function inboxRowTone(record: SwitchboardTaskRecord): Tone {
  const triageImportance = parseTriageImportance(latestTriageComment(record))
  if (triageImportance === 'critical') return 'error'
  if (triageImportance === 'high') return 'warn'
  if (record.task.source.type === 'watchtower') return 'accent'
  return 'neutral'
}

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

export default function WatchtowerPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const folderPath = workspace?.folderPath ?? null
  const { state, tasks, problems, refresh } = useSwitchboardData(folderPath)

  const inbox = useMemo(() => filterInboxTasks(tasks), [tasks])
  const [runs, setRuns] = useState<WatchtowerRun[]>([])
  const [importResult, setImportResult] = useState<SwitchboardImportResult | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [preset, setPreset] = useState<WatchtowerReviewPresetId>('lean_code_review')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [draft, setDraft] = useState<DraftTask>(emptyDraft)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<DraftTask>(emptyDraft)
  const [commentBody, setCommentBody] = useState('')
  const [fileView, setFileView] = useState<{ path: string; name: string; content: string } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const { isPending, run: runAction } = usePendingActions<PendingKey>()
  const feedback = useActionFeedback()

  useEffect(() => {
    if (selectedId && !inbox.some((record) => record.task.id === selectedId)) {
      setSelectedId(inbox[0]?.task.id ?? null)
      setEditing(false)
    } else if (!selectedId && inbox.length > 0) {
      setSelectedId(inbox[0].task.id)
    }
  }, [inbox, selectedId])

  const selected = useMemo(
    () => inbox.find((record) => record.task.id === selectedId) ?? null,
    [inbox, selectedId]
  )
  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  )
  const selectedRunAgentOutcomes = useMemo(
    () => (selectedRun ? countAgentOutcomes(selectedRun, tasks) : new Map<string, AgentTaskOutcome>()),
    [selectedRun, tasks]
  )

  useEffect(() => {
    setFileView(null)
    setFileError(null)
  }, [selectedId])

  const handleOpenFile = useCallback(async () => {
    if (!selected) return
    const path = selected.location.path
    setLoadingFile(true)
    setFileError(null)
    try {
      const exists = await window.api.pathExists(path)
      if (!exists) {
        setFileError('File could not be found at its recorded location.')
        return
      }
      const content = await window.api.readfile(path)
      const name = path.split(/[\\/]/).pop() ?? path
      setFileView({ path, name, content })
    } catch (error) {
      setFileError(error instanceof Error ? error.message : 'Could not read file.')
    } finally {
      setLoadingFile(false)
    }
  }, [selected])

  const handleCloseFile = useCallback(() => {
    setFileView(null)
    setFileError(null)
  }, [])

  const handlePopOutFile = useCallback(() => {
    if (!fileView) return
    openFile(workspaceId, fileView.path, fileView.name, fileView.content)
    focusOrAddFileTab(workspaceId, fileView.path, fileView.name)
    setFileView(null)
  }, [fileView, openFile, workspaceId])

  const notifyStartFailure = useCallback(
    (kind: WatchtowerStartKind, message: string) => {
      const userMessage = watchtowerStartErrorMessage(message)
      feedback.notify('runReview', 'error', userMessage)
      publishDiagnosticSync({
        level: 'error',
        source: 'workspace',
        title: kind === 'review' ? 'Watchtower review did not start' : 'Watchtower triage did not start',
        message: userMessage,
        details: message === userMessage ? undefined : message,
        workspaceId,
        workspaceName: workspace?.name,
      })
    },
    [feedback, workspace?.name, workspaceId]
  )

  const refreshRuns = useCallback(async () => {
    if (!folderPath) {
      setRuns([])
      return
    }
    const result = await window.api.listWatchtowerRuns(folderPath)
    if (!result.ok) {
      feedback.notify('runReview', 'error', result.message)
      return
    }
    setRuns(result.runs)
    setSelectedRunId((current) => current && result.runs.some((run) => run.runId === current)
      ? current
      : result.runs[0]?.runId ?? null)
  }, [folderPath, feedback])

  useEffect(() => {
    void refreshRuns()
  }, [refreshRuns])

  const activeRun = useMemo(
    () => runs.find((run) => run.status === 'running' || run.status === 'pending'
      || run.agents.some((agent) => agent.status === 'running' || agent.status === 'pending')) ?? null,
    [runs]
  )
  const hasActiveRun = activeRun !== null
  const liveRunningAgents = useMemo(() => {
    if (!activeRun) return [] as WatchtowerRunAgent[]
    return activeRun.agents.filter(
      (agent) => agent.status === 'running' || agent.status === 'pending'
    )
  }, [activeRun])

  useEffect(() => {
    if (!hasActiveRun) return
    const handle = window.setInterval(() => {
      void refreshRuns()
    }, 5_000)
    return () => window.clearInterval(handle)
  }, [hasActiveRun, refreshRuns])

  const handleRefreshAll = useCallback(async () => {
    await runAction('refresh', async () => {
      await Promise.all([refresh(), refreshRuns()])
    })
  }, [refresh, refreshRuns, runAction])

  const selectedPreset = useMemo(
    () => WATCHTOWER_REVIEW_PRESETS.find((item) => item.id === preset) ?? WATCHTOWER_REVIEW_PRESETS[0],
    [preset]
  )

  const handleStartReview = useCallback(async () => {
    if (!folderPath) return
    const hasAgents = Object.values(selectedPreset.agents).some((sectors) => (sectors ?? []).length > 0)
    if (!hasAgents) {
      feedback.notify('runReview', 'error', 'Select a preset with at least one review agent.')
      return
    }
    await runAction('startReview', async () => {
      try {
        const started = await window.api.startWatchtowerReview({
          workspaceRoot: folderPath,
          workspaceId,
          preset,
          mcpSettings,
        })
        if (!started.ok) {
          notifyStartFailure('review', started.message)
          return
        }
        setSelectedRunId(started.run.runId)
        await refreshRuns()
        setReviewOpen(false)
        setDrawerOpen(true)
        feedback.notify('runReview', 'success', 'Review started.')
      } catch (caught) {
        notifyStartFailure('review', caught instanceof Error ? caught.message : 'Watchtower review did not start.')
      }
    })
  }, [feedback, folderPath, mcpSettings, notifyStartFailure, preset, refreshRuns, runAction, selectedPreset.agents, workspaceId])

  const handleStartTriage = useCallback(
    async (scope: 'all' | 'selected') => {
      if (!folderPath) return
      const scopedTasks = scope === 'selected' ? (selected ? [selected] : []) : inbox
      const feedbackKey: FeedbackKey = scope === 'selected' ? 'detail' : 'runReview'
      if (scopedTasks.length === 0) {
        feedback.notify(
          feedbackKey,
          'info',
          scope === 'selected' ? 'Select an inbox task to triage.' : 'No inbox tasks to triage.'
        )
        return
      }

      const pendingKey: PendingKey = scope === 'selected' ? 'startTriageSelected' : 'startTriageAll'
      await runAction(pendingKey, async () => {
        try {
          const started = await window.api.startWatchtowerTriage({
            workspaceRoot: folderPath,
            workspaceId,
            scope: scope === 'selected' ? 'selected' : 'all',
            taskId: scope === 'selected' ? scopedTasks[0]?.task.id : undefined,
            mcpSettings,
          })
          if (!started.ok) {
            notifyStartFailure('triage', started.message)
            return
          }
          setSelectedRunId(started.run.runId)
          await refreshRuns()
          setDrawerOpen(true)
          feedback.notify(
            feedbackKey,
            'success',
            scope === 'selected'
              ? 'Architect triage started for this task.'
              : `Architect triaging ${scopedTasks.length} item${scopedTasks.length === 1 ? '' : 's'}.`
          )
        } catch (caught) {
          notifyStartFailure(
            'triage',
            caught instanceof Error ? caught.message : 'Watchtower triage did not start.'
          )
        }
      })
    },
    [feedback, folderPath, inbox, mcpSettings, notifyStartFailure, refreshRuns, runAction, selected, workspaceId]
  )

  const handleImportGitHub = useCallback(async () => {
    if (!folderPath) return
    await runAction('importGitHub', async () => {
      const result = await window.api.importGitHubIssuesToWatchtower(folderPath)
      setImportResult(result)
      if (!result.ok) {
        feedback.notify('fetchExternal', result.unavailable ? 'info' : 'error', result.message)
        return
      }
      await refresh()
      setDrawerOpen(true)
      feedback.notify(
        'fetchExternal',
        'success',
        `GitHub: ${result.summary.created} created, ${result.summary.skipped} skipped.`
      )
    })
  }, [feedback, folderPath, refresh, runAction])

  const handleImportJira = useCallback(async () => {
    if (!folderPath) return
    await runAction('importJira', async () => {
      const result = await window.api.importJiraIssuesToWatchtower(folderPath)
      setImportResult(result)
      if (result.ok) {
        await refresh()
        setDrawerOpen(true)
        feedback.notify(
          'fetchExternal',
          'success',
          `Jira: ${result.summary.created} created, ${result.summary.skipped} skipped.`
        )
      } else {
        feedback.notify('fetchExternal', result.unavailable ? 'info' : 'error', result.message)
      }
    })
  }, [feedback, folderPath, refresh, runAction])

  // CommandPalette → panel-command bridge. Mirrors the overflow item ids.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const id = (event as CustomEvent).detail?.id
      if (typeof id !== 'string') return
      switch (id) {
        case 'watchtower.run.review':
          setReviewOpen(true)
          break
        case 'watchtower.triage.inbox':
          void handleStartTriage('all')
          break
        case 'watchtower.open.active-review':
          setDrawerOpen(true)
          break
        case 'watchtower.import.github':
          void handleImportGitHub()
          break
        case 'watchtower.import.jira':
          void handleImportJira()
          break
        case 'watchtower.refresh.board':
          void handleRefreshAll()
          break
      }
    }
    window.addEventListener('multicode:panel-command', onCommand)
    return () => window.removeEventListener('multicode:panel-command', onCommand)
  }, [handleImportGitHub, handleImportJira, handleRefreshAll, handleStartTriage])

  const handleCreate = useCallback(async () => {
    if (!folderPath || !draft.title.trim()) return
    await runAction('create', async () => {
      const labels = draft.labels.split(',').map((label) => label.trim()).filter(Boolean)
      const result = await window.api.createSwitchboardTask({
        workspaceRoot: folderPath,
        origin: 'watchtower',
        title: draft.title.trim(),
        description: draft.description,
        priority: draft.priority,
        labels,
        identifier: draft.identifier.trim() || undefined,
        source: { type: 'watchtower' },
      })
      if (!result.ok) {
        feedback.notify('inboxList', 'error', result.message)
        return
      }
      setSelectedId(result.record.task.id)
      setDraft(emptyDraft)
      setCreateOpen(false)
      await refresh()
      feedback.notify('inboxList', 'success', 'Task added to inbox.')
    })
  }, [draft, feedback, folderPath, refresh, runAction])

  const handlePromote = useCallback(async () => {
    if (!folderPath || !selected) return
    await runAction('promote', async () => {
      const result = await window.api.promoteSwitchboardInboxTask({
        workspaceRoot: folderPath,
        id: selected.task.id,
      })
      if (!result.ok) {
        feedback.notify('detail', 'error', result.message)
        return
      }
      await refresh()
      feedback.notify('detail', 'success', 'Promoted to Switchboard todo.')
    })
  }, [feedback, folderPath, refresh, runAction, selected])

  const handleCancel = useCallback(async () => {
    if (!folderPath || !selected) return
    await runAction('cancelTask', async () => {
      const result = await window.api.cancelSwitchboardTask({
        workspaceRoot: folderPath,
        id: selected.task.id,
      })
      if (!result.ok) {
        feedback.notify('detail', 'error', result.message)
        return
      }
      await refresh()
      feedback.notify('detail', 'info', 'Task canceled.')
    })
  }, [feedback, folderPath, refresh, runAction, selected])

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

  const handleInboxKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (isEditableInboxTarget(event.target)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'c') {
        event.preventDefault()
        setCreateOpen(true)
        return
      }

      if (event.key === 'Escape') {
        if (editing) {
          event.preventDefault()
          setEditing(false)
        }
        return
      }

      const navKeys = ['ArrowDown', 'ArrowUp', 'j', 'k']
      if (!navKeys.includes(event.key)) return
      event.preventDefault()

      if (inbox.length === 0) return
      const currentIdx = selectedId
        ? inbox.findIndex((record) => record.task.id === selectedId)
        : -1
      const delta = event.key === 'ArrowDown' || event.key === 'j' ? 1 : -1
      const nextIdx = Math.min(Math.max((currentIdx < 0 ? 0 : currentIdx) + delta, 0), inbox.length - 1)
      const nextRecord = inbox[nextIdx]
      if (nextRecord && nextRecord.task.id !== selectedId) {
        setSelectedId(nextRecord.task.id)
        setEditing(false)
      }
    },
    [editing, inbox, selectedId]
  )

  const startEdit = useCallback(() => {
    if (!selected) return
    setEditForm({
      title: selected.task.title,
      description: selected.task.description,
      priority: selected.task.priority,
      labels: selected.task.labels.join(', '),
      identifier: selected.task.identifier,
    })
    setEditing(true)
  }, [selected])

  const handleEditSave = useCallback(async () => {
    if (!folderPath || !selected) return
    await runAction('edit', async () => {
      const labels = editForm.labels.split(',').map((label) => label.trim()).filter(Boolean)
      const result = await window.api.updateSwitchboardTask({
        workspaceRoot: folderPath,
        id: selected.task.id,
        updates: {
          title: editForm.title.trim() || selected.task.title,
          description: editForm.description,
          priority: editForm.priority,
          labels,
          identifier: editForm.identifier.trim() || selected.task.identifier,
        },
      })
      if (!result.ok) {
        feedback.notify('detail', 'error', result.message)
        return
      }
      setEditing(false)
      await refresh()
      feedback.notify('detail', 'success', 'Task updated.')
    })
  }, [editForm, feedback, folderPath, refresh, runAction, selected])

  const overflowItems = useMemo<OverflowMenuItem[]>(() => {
    return [
      {
        id: 'watchtower.triage.inbox',
        label: isPending('startTriageAll') ? 'Starting triage…' : 'Triage inbox',
        disabled: inbox.length === 0 || isPending('startTriageAll'),
        onSelect: () => void handleStartTriage('all'),
      },
      {
        id: 'watchtower.open.active-review',
        label: 'Active review',
        onSelect: () => setDrawerOpen(true),
      },
      { kind: 'separator', id: 'sep-1' },
      {
        id: 'watchtower.import.github',
        label: isPending('importGitHub') ? 'Importing GitHub…' : 'Import from GitHub',
        disabled: isPending('importGitHub'),
        onSelect: () => void handleImportGitHub(),
      },
      {
        id: 'watchtower.import.jira',
        label: isPending('importJira') ? 'Importing Jira…' : 'Import from Jira',
        disabled: isPending('importJira'),
        onSelect: () => void handleImportJira(),
      },
      { kind: 'separator', id: 'sep-2' },
      {
        id: 'watchtower.refresh.board',
        label: isPending('refresh') ? 'Refreshing…' : 'Refresh',
        disabled: isPending('refresh'),
        onSelect: () => void handleRefreshAll(),
      },
    ]
  }, [
    handleImportGitHub,
    handleImportJira,
    handleRefreshAll,
    handleStartTriage,
    inbox.length,
    isPending,
  ])

  if (!workspace) {
    return (
      <div className="h-full bg-[color:var(--bg-app)] p-4 text-[12px] text-[color:var(--text-muted)]">
        Workspace not found.
      </div>
    )
  }

  if (!folderPath) {
    return (
      <div className="h-full bg-[color:var(--bg-app)] p-6 text-[12px] text-[color:var(--text-muted)]">
        Choose a workspace folder to use Watchtower.
      </div>
    )
  }

  const inboxStatus = feedback.statuses.inboxList ?? null
  const inboxEmptyText = inboxEmptyMessage(state.kind, runs)

  return (
    <div className="relative flex h-full min-h-0 bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <section
        className="flex w-[44%] min-w-[320px] max-w-[560px] flex-col border-r border-[color:var(--border-default)]"
        aria-labelledby={INBOX_TITLE_ID}
      >
        <PanelHeader
          tool="watchtower"
          title="Inbox"
          titleId={INBOX_TITLE_ID}
          count={inbox.length}
          primaryAction={
            <PrimaryButton
              onClick={() => setReviewOpen(true)}
              disabled={isPending('startReview')}
              aria-label="Open review preset chooser"
            >
              {isPending('startReview') ? 'Starting…' : 'Review'}
            </PrimaryButton>
          }
          overflow={<OverflowMenu ariaLabel="Watchtower overflow" items={overflowItems} />}
        />

        {state.kind === 'error' ? (
          <Banner tone="error" message={state.message} onRetry={refresh} />
        ) : null}
        {problems.length > 0 ? (
          <Banner
            tone="warning"
            message={`${problems.length} task file${problems.length === 1 ? '' : 's'} could not be parsed. Folder reads continue.`}
          />
        ) : null}
        {activeRun ? (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open active review"
            className="interactive flex items-center gap-2 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-1.5 text-left text-[12px] hover:bg-[color:var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
          >
            <StatusDot tone="warn" pulse label="Agents running" />
            <span className="font-medium text-[color:var(--text-strong)]">
              {isTriageRun(activeRun) ? 'Triage running' : 'Review running'}
            </span>
            <span aria-hidden className="text-[color:var(--text-disabled)]">·</span>
            <span className="min-w-0 flex-1 truncate text-[color:var(--text-muted)]">
              {liveRunningAgents.length > 0
                ? liveRunningAgents.map(specialistShortLabel).join(', ')
                : 'Architect spinning up…'}
            </span>
            <span className="shrink-0 font-medium text-[color:var(--accent-primary)]">
              View
            </span>
          </button>
        ) : null}
        {inboxStatus ? (
          <div className="flex items-center gap-2 border-b border-[color:var(--border-default)] px-3 py-1.5">
            <ActionStatusChip
              status={inboxStatus}
              onDismiss={inboxStatus.tone === 'error' ? () => feedback.dismiss('inboxList') : undefined}
            />
          </div>
        ) : null}

        <div
          tabIndex={0}
          onKeyDown={handleInboxKeyDown}
          className="flex-1 overflow-auto focus:outline-none"
          aria-label="Inbox tasks"
        >
          {state.kind === 'loading' && inbox.length === 0 ? (
            <InboxSkeleton />
          ) : inbox.length === 0 ? (
            <div className="px-3 py-6 text-[12px] leading-5 text-[color:var(--text-muted)]">
              {inboxEmptyText}
            </div>
          ) : (
            <ul>
              {inbox.map((record) => (
                <li key={record.task.id}>
                  <WatchtowerInboxRow
                    record={record}
                    selected={selectedId === record.task.id}
                    onSelect={() => {
                      setSelectedId(record.task.id)
                      setEditing(false)
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Selected task detail">
        {selected ? (
          fileView ? (
            <WatchtowerFilePreview
              artifact={fileView}
              onBack={handleCloseFile}
              onPopOut={handlePopOutFile}
            />
          ) : (
            <DetailPane
              record={selected}
              editing={editing}
              editForm={editForm}
              onEditFormChange={setEditForm}
              onStartEdit={startEdit}
              onCancelEdit={() => setEditing(false)}
              onSaveEdit={handleEditSave}
              onPromote={handlePromote}
              onCancelTask={handleCancel}
              onTriageTask={() => void handleStartTriage('selected')}
              onOpenFile={() => void handleOpenFile()}
              loadingFile={loadingFile}
              fileError={fileError}
              onDismissFileError={() => setFileError(null)}
              commentBody={commentBody}
              onCommentChange={setCommentBody}
              onAddComment={handleAddComment}
              isEditing={isPending('edit')}
              isPromoting={isPending('promote')}
              isCanceling={isPending('cancelTask')}
              isTriaging={isPending('startTriageSelected')}
              isCommenting={isPending('addComment')}
              detailStatus={feedback.statuses.detail ?? null}
              commentStatus={feedback.statuses.comment ?? null}
              onDismissDetailStatus={() => feedback.dismiss('detail')}
              onDismissCommentStatus={() => feedback.dismiss('comment')}
            />
          )
        ) : (
          <EmptyDetail />
        )}
      </section>

      {drawerOpen ? (
        <WatchtowerActiveReviewAside
          onClose={() => setDrawerOpen(false)}
          runs={runs}
          selectedRun={selectedRun}
          onSelectRun={(runId) => setSelectedRunId(runId)}
          agentOutcomes={selectedRunAgentOutcomes}
          importResult={importResult}
          workspaceId={workspaceId}
          workspaceRoot={folderPath}
          runStatus={feedback.statuses.runReview ?? null}
          onDismissRunStatus={() => feedback.dismiss('runReview')}
          fetchStatus={feedback.statuses.fetchExternal ?? null}
          onDismissFetchStatus={() => feedback.dismiss('fetchExternal')}
        />
      ) : null}

      {reviewOpen ? (
        <ReviewPresetChooser
          preset={preset}
          onPresetChange={setPreset}
          onClose={() => setReviewOpen(false)}
          onStart={handleStartReview}
          starting={isPending('startReview')}
        />
      ) : null}

      {createOpen ? (
        <CreateInboxDialog
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

function inboxEmptyMessage(stateKind: 'idle' | 'loading' | 'ready' | 'error', runs: WatchtowerRun[]): string {
  if (stateKind !== 'ready') return 'No inbox tasks yet.'
  if (runs.length === 0) return 'Inbox empty. Run a review or fetch issues.'
  const activeRun = runs.find((run) => run.status === 'running' || run.status === 'pending'
    || run.agents.some((agent) => agent.status === 'running' || agent.status === 'pending'))
  if (activeRun) {
    return isTriageRun(activeRun)
      ? 'Architect triaging. Tasks stay here until you promote or cancel them.'
      : 'Reviewers running. Tasks land here as each one finds something.'
  }
  const lastRun = runs[0]
  const failedAgents = lastRun?.agents.filter((agent) => agent.status === 'failed') ?? []
  if (lastRun && failedAgents.length > 0) {
    const verb = isTriageRun(lastRun) ? 'triage' : 'review'
    const names = failedAgents.map((agent) => specialistShortLabel(agent)).join(', ')
    return `Last ${verb}: ${names} failed. Open Active review to see details.`
  }
  if (lastRun && isTriageRun(lastRun)) return 'Last triage finished. Run a review or fetch issues to add new work.'
  return 'Last review found nothing actionable. Run another review or fetch issues.'
}

function specialistShortLabel(agent: WatchtowerRunAgent): string {
  if (!agent.specialistId) return agent.agentId
  try {
    return getSpecialistAction(agent.specialistId as SpecialistActionId).shortLabel
  } catch {
    return agent.specialistId
  }
}

function agentRowTone(agent: WatchtowerRunAgent, outcome: AgentTaskOutcome, triage: boolean): {
  tone: Tone
  pulse: boolean
  label: string
} {
  const { count, total } = outcome
  if (triage) {
    const scope = total ?? agent.taskIds?.length ?? 0
    switch (agent.status) {
      case 'running':
        return {
          tone: 'warn',
          pulse: true,
          label: scope > 0 ? `Triaging ${count}/${scope}` : 'Triaging…',
        }
      case 'pending':
        return { tone: 'neutral', pulse: false, label: 'Queued' }
      case 'completed':
        if (scope === 0) return { tone: 'neutral', pulse: false, label: 'Nothing to triage' }
        if (count === 0) return { tone: 'warn', pulse: false, label: `0 of ${scope} triaged` }
        if (count < scope) return { tone: 'good', pulse: false, label: `Triaged ${count} of ${scope}` }
        return { tone: 'good', pulse: false, label: `Triaged ${count} item${count === 1 ? '' : 's'}` }
      case 'failed':
        return { tone: 'error', pulse: false, label: scope > 0 ? `Failed after ${count}/${scope}` : 'Failed' }
      case 'canceled':
        return { tone: 'neutral', pulse: false, label: 'Canceled' }
      default:
        return { tone: 'neutral', pulse: false, label: agent.status }
    }
  }
  switch (agent.status) {
    case 'running':
      return {
        tone: 'warn',
        pulse: true,
        label: count > 0 ? `Reviewing · ${count} added` : 'Reviewing…',
      }
    case 'pending':
      return { tone: 'neutral', pulse: false, label: 'Queued' }
    case 'completed':
      return { tone: 'good', pulse: false, label: count === 0 ? 'No findings' : `${count} added` }
    case 'failed':
      return { tone: 'error', pulse: false, label: 'Failed' }
    case 'canceled':
      return { tone: 'neutral', pulse: false, label: 'Canceled' }
    default:
      return { tone: 'neutral', pulse: false, label: agent.status }
  }
}

function runHistoryLabel(run: WatchtowerRun, index: number): string {
  const verb = isTriageRun(run) ? 'Triage' : 'Review'
  const when = formatRelativeTime(run.createdAt)
  return `${verb} ${index + 1} · ${when}`
}

function WatchtowerInboxRow({
  record,
  selected,
  onSelect,
}: {
  record: SwitchboardTaskRecord
  selected: boolean
  onSelect: () => void
}) {
  const task = record.task
  const tone = inboxRowTone(record)
  const descriptionPreview = task.description
    ? task.description.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? null
    : null
  const fallbackSupporting = task.labels.length > 0 ? task.labels.join(' · ') : null
  const title = (
    <>
      <span className="mr-2 font-mono tabular-nums text-[11px] text-[color:var(--text-muted)]">
        {shortIdentifier(record)}
      </span>
      {task.title}
    </>
  )
  return (
    <InboxRow
      tone={tone}
      title={title}
      supporting={descriptionPreview ?? fallbackSupporting ?? undefined}
      trailing={formatRelativeTime(task.createdAt)}
      selected={selected}
      onSelect={onSelect}
      ariaLabel={`${shortIdentifier(record)} ${task.title}`}
    />
  )
}

function InboxSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading inbox">
      <ul>
        {Array.from({ length: 5 }).map((_, idx) => (
          <li key={idx} className="border-b border-[color:var(--border-subtle)] px-3 py-2">
            <div className="flex items-baseline gap-2">
              <div className="skeleton-shimmer h-2.5 w-12 rounded bg-[color:var(--bg-surface-raised)]" />
              <div className="skeleton-shimmer h-3 flex-1 rounded bg-[color:var(--bg-surface-raised)]" />
              <div className="skeleton-shimmer h-2.5 w-10 rounded bg-[color:var(--bg-surface-raised)]" />
            </div>
            <div className="skeleton-shimmer mt-1.5 h-2.5 w-[70%] rounded bg-[color:var(--bg-surface-raised)]" />
          </li>
        ))}
      </ul>
    </div>
  )
}

function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-[12px] font-semibold text-[color:var(--text-default)]">Triage</div>
      <div className="text-[12px] text-[color:var(--text-muted)]">
        Select an inbox task to inspect, edit, comment, or promote.
      </div>
    </div>
  )
}

function WatchtowerFilePreview({
  artifact,
  onBack,
  onPopOut,
}: {
  artifact: { path: string; name: string; content: string }
  onBack: () => void
  onPopOut: () => void
}) {
  const isMarkdown = artifact.path.toLowerCase().endsWith('.md')
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-default)] px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[12px] font-semibold text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            aria-label="Back to task detail"
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
              <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </button>
          <span
            className="min-w-0 truncate font-mono text-[12.5px] tabular-nums text-[color:var(--text-strong)]"
            title={artifact.path}
          >
            {artifact.name}
          </span>
        </div>
        <Tooltip content="Open in editor tab">
          <button
            type="button"
            onClick={onPopOut}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[11px] font-semibold text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            aria-label="Open in editor tab"
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
              <path d="M9 3H13V7M13 3L7.5 8.5M6 4H4C3.45 4 3 4.45 3 5V12C3 12.55 3.45 13 4 13H11C11.55 13 12 12.55 12 12V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Open in editor
          </button>
        </Tooltip>
      </header>
      <div className="flex-1 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
        {isMarkdown ? (
          <div className="markdown-body">{renderMarkdown(artifact.content)}</div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-5 text-[color:var(--text-default)]">
            {artifact.content}
          </pre>
        )}
      </div>
    </div>
  )
}

function WatchtowerActiveReviewAside({
  onClose,
  runs,
  selectedRun,
  onSelectRun,
  agentOutcomes,
  importResult,
  workspaceId,
  workspaceRoot,
  runStatus,
  onDismissRunStatus,
  fetchStatus,
  onDismissFetchStatus,
}: {
  onClose: () => void
  runs: WatchtowerRun[]
  selectedRun: WatchtowerRun | null
  onSelectRun: (runId: string) => void
  agentOutcomes: Map<string, AgentTaskOutcome>
  importResult: SwitchboardImportResult | null
  workspaceId: string
  workspaceRoot: string | null
  runStatus: ActionStatus | null
  onDismissRunStatus: () => void
  fetchStatus: ActionStatus | null
  onDismissFetchStatus: () => void
}) {
  const terminalSessions = useTerminalSessions()
  const triageRun = selectedRun ? isTriageRun(selectedRun) : false

  const importItems = useMemo(() => {
    if (!importResult) return []
    return importResult.ok ? importResult.items.slice(0, 8) : []
  }, [importResult])

  const runLabel = selectedRun
    ? selectedRun.status === 'running' || selectedRun.status === 'pending'
      ? triageRun ? 'Active triage' : 'Active review'
      : triageRun ? 'Last triage' : 'Last review'
    : null

  return (
    <aside
      aria-label="Active review"
      className="flex w-[38%] min-w-[320px] max-w-[520px] flex-col border-l border-[color:var(--border-default)] bg-[color:var(--bg-app)]"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
        <h3 className="truncate text-[13px] font-semibold tracking-tight text-[color:var(--text-strong)]">
          Active review
        </h3>
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
          {selectedRun ? (
            <span className="tabular-nums">
              {runs.length} run{runs.length === 1 ? '' : 's'}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close active review"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
          >
            <svg className="icon-sm" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M3.25 3.25L10.75 10.75M10.75 3.25L3.25 10.75"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {runStatus ? (
          <div className="px-3 pt-3">
            <ActionStatusChip
              status={runStatus}
              onDismiss={runStatus.tone === 'error' ? onDismissRunStatus : undefined}
            />
          </div>
        ) : null}

        {selectedRun ? (
          <Section
            title={runLabel ?? 'Active review'}
            level={4}
            action={
              runs.length > 1 ? (
                <div className="inline-flex max-w-[180px] items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
                  <Select<string>
                    ariaLabel="Switch run"
                    items={runs.slice(0, 8).map((run, index) => ({
                      value: run.runId,
                      label: runHistoryLabel(run, index),
                    }))}
                    value={selectedRun.runId}
                    onChange={(value) => onSelectRun(value)}
                  />
                </div>
              ) : null
            }
          >
            <ul className="-mx-3">
              {selectedRun.agents.length === 0 ? (
                <li className="flex min-w-0 items-center gap-2.5 border-b border-[color:var(--border-default)] px-3 py-2.5">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
                    aria-hidden="true"
                  >
                    <SpecialistActionIcon icon="architecture" className="icon-md" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                    {triageRun ? 'Architect spinning up…' : 'Reviewers spinning up…'}
                  </span>
                  <StatusDot tone="warn" pulse label="Spinning up" />
                </li>
              ) : null}
              {selectedRun.agents.map((agent) => {
                const outcome = agentOutcomes.get(agent.agentId) ?? { count: 0 }
                const tone = agentRowTone(agent, outcome, triageRun)
                const terminalState = describeExecutionTerminal(
                  terminalSessions,
                  workspaceId,
                  agent.executionId
                )
                const canOpenTerminal =
                  terminalState.kind !== 'missing' && Boolean(workspaceRoot) && Boolean(agent.executionId)
                const terminalTabOpen =
                  terminalState.kind !== 'missing'
                    ? hasAgentTab(workspaceId, terminalState.agentId)
                    : false
                const terminalButtonLabel = terminalTabOpen ? 'Focus' : 'Terminal'
                const handleOpenTerminal = (): void => {
                  if (!canOpenTerminal || !agent.executionId) return
                  void import('../../utils/modelRegistry').then(({ focusOrAddAgentSessionTab }) => {
                    void focusOrAddAgentSessionTab(workspaceId, {
                      executionId: agent.executionId!,
                      fallbackName: specialistShortLabel(agent),
                    })
                  })
                }
                const action = agent.specialistId ? getSpecialistAction(agent.specialistId as SpecialistActionId) : null
                const role = action ? soulRoleToSprintEngineRole(action.soulRole) : null
                const displayLabel = role ? sprintEngineRoleLabels[role] : (action?.shortLabel ?? specialistShortLabel(agent))
                const discStyle = role
                  ? {
                      backgroundColor: hexToRgba(sprintEngineRoleAccent[role], 0.18),
                      color: sprintEngineRoleAccent[role],
                    }
                  : undefined
                const hasError = Boolean(agent.errorMessage)
                return (
                  <li
                    key={agent.agentId}
                    className="border-b border-[color:var(--border-default)] last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                          role ? '' : 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]'
                        }`}
                        // design-tokens-allow: role glyph is the documented exception to the one-accent rule; see knowledge/brand/panel-design-system.md.
                        style={discStyle}
                        aria-hidden="true"
                      >
                        {role ? (
                          <SprintEngineRoleIcon role={role} className="icon-md" />
                        ) : (
                          <SpecialistActionIcon icon={action?.icon ?? 'review'} className="icon-md" />
                        )}
                      </span>
                      {hasError ? (
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <span className="block min-w-0 truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                            {displayLabel}
                          </span>
                          <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                            <StatusDot tone={tone.tone} pulse={tone.pulse} />
                            <span
                              className="min-w-0 flex-1 truncate text-[color:var(--tone-error)]"
                              title={agent.errorMessage ?? undefined}
                            >
                              {agent.errorMessage}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                            {displayLabel}
                          </span>
                          <StatusDot tone={tone.tone} pulse={tone.pulse} />
                          <span className="shrink-0 text-[11px] text-[color:var(--text-muted)]">
                            {tone.label}
                          </span>
                        </>
                      )}
                      {canOpenTerminal ? (
                        <GhostButton
                          size="sm"
                          className="!h-6 shrink-0"
                          onClick={handleOpenTerminal}
                        >
                          {terminalButtonLabel}
                        </GhostButton>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Section>
        ) : (
          <Section title="No active review" level={4}>
            <div className="text-[12px] text-[color:var(--text-muted)]">
              Start a review or fetch issues to populate this drawer.
            </div>
          </Section>
        )}

        {importResult ? (
          <Section
            title={`Last import · ${importResult.provider}`}
            level={4}
            action={
              fetchStatus ? (
                <ActionStatusChip
                  status={fetchStatus}
                  onDismiss={fetchStatus.tone === 'error' ? onDismissFetchStatus : undefined}
                />
              ) : null
            }
          >
            {importResult.ok ? (
              <>
                <DefinitionList
                  layout="two-column"
                  items={[
                    { term: 'Created', description: <span className="tabular-nums">{importResult.summary.created}</span> },
                    { term: 'Updated', description: <span className="tabular-nums">{importResult.summary.updated}</span> },
                    { term: 'Skipped', description: <span className="tabular-nums">{importResult.summary.skipped}</span> },
                    { term: 'Errors', description: <span className="tabular-nums">{importResult.summary.errors}</span> },
                  ]}
                />
                {importItems.length > 0 ? (
                  <ul className="mt-2 max-h-32 overflow-auto border-t border-[color:var(--border-default)] pt-2">
                    {importItems.map((item, index) => {
                      const itemTone: Tone =
                        item.status === 'created' ? 'good' : item.status === 'error' ? 'error' : 'neutral'
                      return (
                        <li
                          key={`${item.externalKey ?? item.externalUrl ?? index}:${index}`}
                          className="flex min-w-0 items-center gap-2 py-0.5 text-[11px]"
                        >
                          <StatusDot tone={itemTone} />
                          <span className="shrink-0 text-[color:var(--text-muted)]">{item.status}</span>
                          <span className="truncate font-mono text-[color:var(--text-default)]">
                            {item.externalKey ?? item.externalUrl ?? 'unknown source'}
                          </span>
                          {item.message ? (
                            <span className="truncate text-[color:var(--text-subtle)]">{item.message}</span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </>
            ) : (
              <div className="text-[12px] text-[color:var(--tone-error)]">{importResult.message}</div>
            )}
          </Section>
        ) : null}
      </div>
    </aside>
  )
}

function ReviewPresetChooser({
  preset,
  onPresetChange,
  onClose,
  onStart,
  starting,
}: {
  preset: WatchtowerReviewPresetId
  onPresetChange: (next: WatchtowerReviewPresetId) => void
  onClose: () => void
  onStart: () => void
  starting: boolean
}) {
  const selectedPreset =
    WATCHTOWER_REVIEW_PRESETS.find((item) => item.id === preset) ?? WATCHTOWER_REVIEW_PRESETS[0]
  const presetAgents = Object.entries(selectedPreset.agents)
  const hasAgents = presetAgents.some(([, sectors]) => (sectors ?? []).length > 0)

  return (
    <Modal open onClose={onClose} contained labelledBy="watchtower-review-title" width={520}>
      <ModalHeader title="Run a review" titleId="watchtower-review-title" onClose={onClose} />
      <ModalBody className="space-y-3">
        <Field label="Preset">
          <Select<WatchtowerReviewPresetId>
            ariaLabel="Review preset"
            items={WATCHTOWER_REVIEW_PRESETS.filter((item) => item.id !== 'custom').map((item) => ({
              value: item.id,
              label: item.label,
            }))}
            value={preset}
            onChange={(value) => onPresetChange(value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] text-[color:var(--text-muted)]">Agents</div>
          {hasAgents ? (
            <ul className="flex flex-col gap-1">
              {presetAgents.map(([specialistId, sectors]) => {
                const specialist = getSpecialistAction(specialistId as SpecialistActionId)
                const labels = (sectors ?? []).map((sector) => getWatchtowerReviewSector(sector).label)
                return (
                  <li
                    key={specialistId}
                    className="flex min-w-0 items-baseline gap-2 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1.5 text-[12px]"
                  >
                    <span className="shrink-0 font-medium text-[color:var(--text-strong)]">
                      {specialist.shortLabel}
                    </span>
                    <span className="min-w-0 truncate text-[color:var(--text-muted)]">
                      {labels.join(', ') || 'No sectors'}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="text-[12px] text-[color:var(--text-muted)]">
              This preset has no agents. Pick another preset to start a review.
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <ModalButton onClick={onClose}>Cancel</ModalButton>
        <ModalButton
          variant="primary"
          onClick={onStart}
          disabled={starting || !hasAgents}
        >
          {starting ? 'Starting…' : 'Start review'}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}

function DetailPane({
  record,
  editing,
  editForm,
  onEditFormChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onPromote,
  onCancelTask,
  onTriageTask,
  onOpenFile,
  loadingFile,
  fileError,
  onDismissFileError,
  commentBody,
  onCommentChange,
  onAddComment,
  isEditing,
  isPromoting,
  isCanceling,
  isTriaging,
  isCommenting,
  detailStatus,
  commentStatus,
  onDismissDetailStatus,
  onDismissCommentStatus,
}: {
  record: SwitchboardTaskRecord
  editing: boolean
  editForm: DraftTask
  onEditFormChange: (next: DraftTask) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onPromote: () => void
  onCancelTask: () => void
  onTriageTask: () => void
  onOpenFile: () => void
  loadingFile: boolean
  fileError: string | null
  onDismissFileError: () => void
  commentBody: string
  onCommentChange: (next: string) => void
  onAddComment: () => void
  isEditing: boolean
  isPromoting: boolean
  isCanceling: boolean
  isTriaging: boolean
  isCommenting: boolean
  detailStatus: ActionStatus | null
  commentStatus: ActionStatus | null
  onDismissDetailStatus: () => void
  onDismissCommentStatus: () => void
}) {
  const task = record.task
  const triageComment = latestTriageComment(record)
  const triageImportance = parseTriageImportance(triageComment)
  const triageTone: Tone =
    triageImportance === 'critical' ? 'error' :
    triageImportance === 'high' ? 'warn' :
    triageImportance === 'medium' ? 'neutral' :
    'neutral'
  const anyDetailMutation = isEditing || isPromoting || isCanceling || isTriaging
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--border-default)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
            <span className="font-mono tabular-nums text-[12px] text-[color:var(--text-default)]">
              {shortIdentifier(record)}
            </span>
            <span aria-hidden="true">·</span>
            <span>Inbox</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatRelativeTime(task.createdAt)}</span>
          </div>
          {editing ? (
            <input
              value={editForm.title}
              onChange={(event) => onEditFormChange({ ...editForm, title: event.target.value })}
              className="mt-2 block w-full bg-transparent text-[15px] font-semibold text-[color:var(--text-strong)] outline-none focus:border-b focus:border-[color:var(--border-strong)]"
            />
          ) : (
            <h3 className="mt-2 text-[15px] font-semibold leading-5 text-[color:var(--text-strong)]">
              {task.title}
            </h3>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {detailStatus ? (
            <ActionStatusChip
              status={detailStatus}
              onDismiss={detailStatus.tone === 'error' ? onDismissDetailStatus : undefined}
            />
          ) : null}
          {fileError ? (
            <ActionStatusChip
              status={{ tone: 'error', message: fileError, nonce: 0 }}
              onDismiss={onDismissFileError}
            />
          ) : null}
          {editing ? (
            <>
              <GhostButton onClick={onCancelEdit} disabled={isEditing}>
                Cancel
              </GhostButton>
              <PrimaryButton onClick={onSaveEdit} disabled={isEditing}>
                {isEditing ? 'Saving…' : 'Save'}
              </PrimaryButton>
            </>
          ) : (
            <>
              <GhostButton onClick={onOpenFile} disabled={anyDetailMutation || loadingFile}>
                {loadingFile ? 'Opening…' : 'View file'}
              </GhostButton>
              <GhostButton onClick={onStartEdit} disabled={anyDetailMutation}>
                Edit
              </GhostButton>
              <GhostButton onClick={onCancelTask} disabled={anyDetailMutation}>
                {isCanceling ? 'Canceling…' : 'Cancel task'}
              </GhostButton>
              <GhostButton onClick={onTriageTask} disabled={anyDetailMutation}>
                {isTriaging ? 'Starting…' : 'Triage task'}
              </GhostButton>
              <PrimaryButton onClick={onPromote} disabled={anyDetailMutation}>
                {isPromoting ? 'Promoting…' : 'Promote to Switchboard'}
              </PrimaryButton>
            </>
          )}
        </div>
      </header>

      {record.warnings.length > 0 ? (
        <div className="border-b border-[color:var(--border-default)] bg-[color:var(--tone-warn-soft)] px-5 py-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
          {record.warnings.map((warning, idx) => (
            <div key={idx}>{warning}</div>
          ))}
        </div>
      ) : null}

      <div className="flex-1 overflow-auto px-5 py-4">
        <DefinitionList
          layout="two-column"
          items={[
            {
              term: 'Identifier',
              description: editing ? (
                <input
                  value={editForm.identifier}
                  onChange={(event) => onEditFormChange({ ...editForm, identifier: event.target.value })}
                  className="block w-48 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1 font-mono tabular-nums text-[12px] text-[color:var(--text-strong)]"
                />
              ) : (
                <span className="font-mono tabular-nums">{task.identifier}</span>
              ),
            },
            {
              term: 'Priority',
              description: editing ? (
                <Select<string>
                  ariaLabel="Task priority"
                  items={[
                    { value: '', label: 'No priority' },
                    { value: '0', label: 'Urgent' },
                    { value: '1', label: 'High' },
                    { value: '2', label: 'Medium' },
                    { value: '3', label: 'Low' },
                  ]}
                  value={editForm.priority == null ? '' : String(editForm.priority)}
                  onChange={(value) => onEditFormChange({ ...editForm, priority: value === '' ? null : Number(value) })}
                />
              ) : (
                <span className="flex items-center gap-2">
                  <PriorityIcon priority={task.priority} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
                  {priorityLabel(task.priority)}
                </span>
              ),
            },
            {
              term: 'Labels',
              description: editing ? (
                <input
                  value={editForm.labels}
                  onChange={(event) => onEditFormChange({ ...editForm, labels: event.target.value })}
                  placeholder="bug, auth"
                  className="block w-full max-w-md rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1 text-[12px] text-[color:var(--text-strong)]"
                />
              ) : task.labels.length > 0 ? (
                <span className="flex flex-wrap gap-1.5">{task.labels.join(' · ')}</span>
              ) : (
                <span className="text-[color:var(--text-muted)]">None</span>
              ),
            },
            {
              term: 'Source',
              description: sourceLabel(record),
            },
            ...(typeof task.creationConfidencePct === 'number'
              ? [{
                  term: 'Legitimacy confidence',
                  description: <ConfidenceChip value={task.creationConfidencePct} />,
                }]
              : []),
            {
              term: 'Created',
              description: <span className="tabular-nums text-[color:var(--text-muted)]">{task.createdAt}</span>,
            },
          ]}
        />

        {triageComment ? (
          <div className="mt-4 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--text-strong)]">
                <SpecialistActionIcon icon="architecture" className="h-3.5 w-3.5 text-[color:var(--text-muted)]" />
                Architect triage
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
                <StatusDot tone={triageTone} />
                {triageImportance ?? 'Triaged'}
              </span>
              {typeof triageComment.confidencePct === 'number' ? (
                <ConfidenceChip value={triageComment.confidencePct} compact title="Triage confidence" />
              ) : null}
              <span className="ml-auto text-[11px] tabular-nums text-[color:var(--text-muted)]">
                {formatRelativeTime(triageComment.createdAt)}
              </span>
            </div>
            <div className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-[color:var(--text-default)]">
              {triageComment.body}
            </div>
          </div>
        ) : null}

        <div className="mt-4 border-t border-[color:var(--border-default)] pt-4">
          <div className="mb-2 text-[12px] font-semibold text-[color:var(--text-strong)]">Description</div>
          {editing ? (
            <textarea
              value={editForm.description}
              onChange={(event) => onEditFormChange({ ...editForm, description: event.target.value })}
              className="min-h-[140px] w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-2 text-[13px] leading-6 text-[color:var(--text-strong)] outline-none focus:border-[color:var(--border-strong)]"
            />
          ) : task.description.trim() ? (
            <div className="whitespace-pre-wrap text-[13px] leading-6 text-[color:var(--text-default)]">
              {task.description}
            </div>
          ) : (
            <div className="text-[12px] text-[color:var(--text-muted)]">No description provided.</div>
          )}
        </div>

        <CommentsSection record={record} />
      </div>

      <footer className="border-t border-[color:var(--border-default)] px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="watchtower-comment-input" className="block text-[12px] font-semibold text-[color:var(--text-strong)]">
            Add comment
          </label>
          {commentStatus ? (
            <ActionStatusChip
              status={commentStatus}
              onDismiss={commentStatus.tone === 'error' ? onDismissCommentStatus : undefined}
            />
          ) : null}
        </div>
        <div className="mt-2 flex gap-2">
          <textarea
            id="watchtower-comment-input"
            value={commentBody}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Note for triage, link a finding, or capture context..."
            rows={2}
            className="min-h-[44px] flex-1 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-2 text-[13px] leading-6 text-[color:var(--text-strong)] outline-none focus:border-[color:var(--border-strong)]"
          />
          <PrimaryButton
            onClick={onAddComment}
            disabled={isCommenting || !commentBody.trim()}
            className="self-end !h-8"
          >
            {isCommenting ? 'Sending…' : 'Comment'}
          </PrimaryButton>
        </div>
      </footer>
    </div>
  )
}

function ConfidenceChip({ value, compact = false, title }: { value: number; compact?: boolean; title?: string }) {
  const label = confidenceLabel(value)
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-0.5 font-medium tabular-nums ${confidenceToneClass(value)} ${
        compact ? 'text-[10.5px]' : 'text-[11px]'
      }`}
      title={title ? `${title}: ${label}` : label}
      aria-label={title ? `${title}: ${label}` : label}
    >
      {/* design-tokens-allow: decorative bullet inheriting the chip text color; not a status dot. */}
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {compact ? `${value}%` : label}
    </span>
  )
}

function CommentsSection({ record }: { record: SwitchboardTaskRecord }) {
  const comments = record.task.comments
  return (
    <div className="mt-4 border-t border-[color:var(--border-default)] pt-4">
      <div className="mb-2 flex items-baseline gap-1.5">
        <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">Activity</span>
        <span className="tabular-nums text-[11px] text-[color:var(--text-muted)]">{comments.length}</span>
      </div>
      {comments.length === 0 ? (
        <div className="text-[12px] text-[color:var(--text-muted)]">No comments yet.</div>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="border-l border-[color:var(--border-default)] pl-3">
              <div className="flex items-baseline gap-2 text-[11px] text-[color:var(--text-muted)]">
                <span className="font-medium text-[color:var(--text-default)]">
                  {comment.author.name ?? comment.author.type}
                </span>
                <span aria-hidden="true">·</span>
                <span>{comment.kind}</span>
                {typeof comment.confidencePct === 'number' ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <ConfidenceChip value={comment.confidencePct} compact />
                  </>
                ) : null}
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{formatRelativeTime(comment.createdAt)}</span>
                {comment.kind === 'comment' ? (
                  <CommentIcon className="ml-1 h-3 w-3 shrink-0 text-[color:var(--text-muted)]" />
                ) : null}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-[color:var(--text-default)]">
                {comment.body}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CreateInboxDialog({
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
    'block w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-[13px] text-[color:var(--text-strong)] outline-none transition-colors placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--border-strong)]'
  return (
    <Modal open onClose={onClose} contained labelledBy="watchtower-create-title" width={540}>
      <ModalHeader title="New inbox task" titleId="watchtower-create-title" onClose={onClose} />
      <ModalBody className="space-y-3">
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
            placeholder="Short triage title"
            className={inputClass}
            autoFocus
          />
        </Field>
        <Field label="Description">
          <textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            rows={4}
            placeholder="What did you observe? What should the next reader know?"
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
              placeholder="WT-7"
              className={`${inputClass} h-9 py-0`}
            />
          </Field>
        </div>
        <Field label="Labels (comma separated)">
          <input
            value={draft.labels}
            onChange={(event) => onChange({ ...draft, labels: event.target.value })}
            placeholder="bug, auth"
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
          Create in inbox
        </ModalButton>
      </ModalFooter>
    </Modal>
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
  const toneVar = tone === 'error' ? '--tone-error' : '--tone-warn'
  const softVar = tone === 'error' ? '--tone-error-soft' : '--tone-warn-soft'
  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-[color:var(--border-default)] px-3 py-2 text-[12px]"
      style={{ backgroundColor: `var(${softVar})`, color: `var(${toneVar})` }}
    >
      <span className="min-w-0 truncate">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="interactive shrink-0 rounded-[5px] border border-current bg-transparent px-2 py-0.5 text-[11px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
