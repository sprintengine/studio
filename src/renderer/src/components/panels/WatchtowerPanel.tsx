import { useCallback, useEffect, useMemo, useState } from 'react'
import { isEditableTarget } from '../../utils/keyboard'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  ActionStatusChip,
  useActionFeedback,
  usePendingActions,
} from '../ui/ActionFeedback'
import {
  WATCHTOWER_REVIEW_PRESETS,
  type WatchtowerReviewPresetId,
} from '../../utils/watchtowerReview'
import { getSpecialistAction } from '../../specialists/specialistActions'
import type { McpSettings, SpecialistActionId, WatchtowerReviewSectorId } from '../../types/workspace'
import type {
  SwitchboardTaskRecord,
  SwitchboardImportResult,
  WatchtowerRun,
  WatchtowerRunAgent,
} from '../../../../shared/switchboard'
import { useSwitchboardData } from '../../utils/switchboardBoard'
import {
  EMPTY_INBOX_FILTERS,
  filterInboxTasks,
  hasActiveInboxFilters,
  taskReviewSectors,
  type InboxFilters,
} from '../../utils/watchtower'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { focusOrAddFileTab } from '../../utils/modelRegistry'
import { WatchtowerInboxRow, InboxSkeleton, EmptyDetail } from './WatchtowerPanel/InboxList'
import { InboxFilterBar } from './WatchtowerPanel/InboxFilters'
import { WatchtowerActiveReviewAside } from './WatchtowerPanel/ActiveReviewAside'
import { ReviewPresetChooser } from './WatchtowerPanel/ReviewPresetChooser'
import { DetailPane } from './WatchtowerPanel/DetailPane'
import { CreateInboxDialog } from './WatchtowerPanel/CreateInboxDialog'
import type { AgentTaskOutcome, DraftTask } from './WatchtowerPanel/types'
import {
  Banner,
  FilePreviewPane,
  FOCUS_RING_INSET_CLASS,
  OverflowMenu,
  PanelHeader,
  PrimaryButton,
  SidePane,
  StatusDot,
  TruncatedText,
  type OverflowMenuItem,
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

type WatchtowerStartKind = 'review' | 'triage'

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

function watchtowerStartErrorMessage(message: string): string {
  return message
}

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

export default function WatchtowerPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const folderPath = workspace?.folderPath ?? null
  const { state, tasks, problems, refresh } = useSwitchboardData(folderPath)

  const allInbox = useMemo(() => filterInboxTasks(tasks), [tasks])
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_INBOX_FILTERS)
  const inbox = useMemo(() => filterInboxTasks(tasks, filters), [tasks, filters])
  const sectorCounts = useMemo(() => {
    const counts = new Map<WatchtowerReviewSectorId, number>()
    for (const record of allInbox) {
      for (const sector of taskReviewSectors(record)) {
        counts.set(sector, (counts.get(sector) ?? 0) + 1)
      }
    }
    return counts
  }, [allInbox])
  useEffect(() => {
    if (filters.sectors.length === 0) return
    const stillPresent = filters.sectors.filter((sector) => (sectorCounts.get(sector) ?? 0) > 0)
    if (stillPresent.length !== filters.sectors.length) {
      setFilters((current) => ({ ...current, sectors: stillPresent }))
    }
  }, [filters.sectors, sectorCounts])
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
      if (isEditableTarget(event.target)) return
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
    const items: OverflowMenuItem[] = []
    if (activeRun) {
      // When a review is running, the primary action becomes "Open review".
      // Starting another review survives here in the overflow so the capability
      // isn't lost — just demoted from primary.
      items.push({
        id: 'watchtower.run.review',
        label: isPending('startReview') ? 'Starting…' : 'Run another review…',
        disabled: isPending('startReview'),
        onSelect: () => setReviewOpen(true),
      })
      items.push({ kind: 'separator', id: 'sep-active-run' })
    }
    items.push(
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
    )
    return items
  }, [
    activeRun,
    handleImportGitHub,
    handleImportJira,
    handleRefreshAll,
    handleStartTriage,
    inbox.length,
    isPending,
  ])

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
        Choose a workspace folder to use Watchtower.
      </div>
    )
  }

  const inboxStatus = feedback.statuses.inboxList ?? null
  const filtersActive = hasActiveInboxFilters(filters)
  const inboxEmptyText =
    filtersActive && allInbox.length > 0
      ? 'No inbox tasks match the current filters.'
      : inboxEmptyMessage(state.kind, runs)

  return (
    <div className="relative flex h-full min-h-0 bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <SidePane as="section" side="left" width="lg" ariaLabelledBy={INBOX_TITLE_ID}>
        <PanelHeader
          tool="watchtower"
          title="Inbox"
          titleId={INBOX_TITLE_ID}
          count={inbox.length}
          primaryAction={
            activeRun ? (
              <PrimaryButton
                onClick={() => setDrawerOpen(true)}
                aria-label="Open active review"
              >
                Open review
              </PrimaryButton>
            ) : (
              <PrimaryButton
                onClick={() => setReviewOpen(true)}
                disabled={isPending('startReview')}
                aria-label="Run a review"
              >
                {isPending('startReview') ? 'Starting…' : 'Run review'}
              </PrimaryButton>
            )
          }
          overflow={<OverflowMenu ariaLabel="Watchtower overflow" items={overflowItems} />}
        />

        {state.kind === 'error' ? (
          <Banner tone="error" message={state.message} onRetry={refresh} />
        ) : null}
        {problems.length > 0 ? (
          <Banner
            tone="warn"
            message={`${problems.length} task file${problems.length === 1 ? '' : 's'} could not be parsed. Folder reads continue.`}
          />
        ) : null}
        {activeRun ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-meta"
          >
            <StatusDot tone="warn" pulse label="Agents running" />
            <span className="font-medium text-[color:var(--text-strong)]">
              {isTriageRun(activeRun) ? 'Triage running' : 'Review running'}
            </span>
            <span aria-hidden className="text-[color:var(--text-disabled)]">·</span>
            <TruncatedText
              as="span"
              className="min-w-0 flex-1 text-[color:var(--text-muted)]"
              text={liveRunningAgents.length > 0
                ? liveRunningAgents.map(specialistShortLabel).join(', ')
                : 'Architect spinning up…'}
            />
          </div>
        ) : null}
        {inboxStatus ? (
          <div className="flex items-center gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
            <ActionStatusChip
              status={inboxStatus}
              onDismiss={inboxStatus.tone === 'error' ? () => feedback.dismiss('inboxList') : undefined}
            />
          </div>
        ) : null}
        <InboxFilterBar
          filters={filters}
          onChange={setFilters}
          sectorCounts={sectorCounts}
        />

        <div
          tabIndex={0}
          onKeyDown={handleInboxKeyDown}
          className={`flex-1 overflow-auto ${FOCUS_RING_INSET_CLASS}`}
          aria-label="Inbox tasks"
        >
          {state.kind === 'loading' && inbox.length === 0 ? (
            <InboxSkeleton />
          ) : inbox.length === 0 ? (
            <div className="px-3 py-6 text-meta leading-5 text-[color:var(--text-muted)]">
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
      </SidePane>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Selected task detail">
        {selected ? (
          fileView ? (
            <FilePreviewPane
              title={
                <span className="font-mono text-body tabular-nums text-[color:var(--text-strong)]">
                  {fileView.name}
                </span>
              }
              path={fileView.path}
              content={fileView.content}
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
