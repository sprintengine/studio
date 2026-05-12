import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Field, Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import {
  ActionStatusChip,
  useActionFeedback,
  usePendingActions,
  type ActionStatus,
  type ActionStatusMap,
} from '../ui/ActionFeedback'
import {
  WATCHTOWER_REVIEW_PRESETS,
  getWatchtowerReviewSector,
  type WatchtowerReviewPresetId,
} from '../../utils/watchtowerReview'
import { getSpecialistAction } from '../../specialists/specialistActions'
import type { SpecialistActionId } from '../../types/workspace'
import type {
  SwitchboardComment,
  SwitchboardTaskRecord,
  SwitchboardImportResult,
  WatchtowerRun,
  WatchtowerRunAgent,
} from '../../../../shared/switchboard'
import {
  ChevronDownIcon,
  CommentIcon,
  MinusIcon,
  PlusIcon,
  PriorityIcon,
  SpecialistActionIcon,
} from '../AppIcons'
import {
  formatRelativeTime,
  priorityLabel,
  shortIdentifier,
  sourceLabel,
  useSwitchboardData,
} from '../../utils/switchboardBoard'
import { filterInboxTasks } from '../../utils/watchtower'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { describeExecutionTerminal, useTerminalSessions } from '../../hooks/useTerminalSessions'
import { hasAgentTab } from '../../utils/modelRegistry'

const PANEL_BG = 'bg-[#08090b]'
const SECTION_DIVIDER = 'border-t border-[#1f2025]'
const ACCENT = '#d97757'
const ARCHITECT_AUTHOR_ID = 'watchtower-architect'

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

export type AgentTaskOutcome = {
  /**
   * For review runs: number of new inbox tasks created by the agent.
   * For triage runs: number of triage comments authored by the architect on scoped tasks.
   */
  count: number
  /**
   * For triage runs: total scoped tasks the agent was asked to triage.
   * For review runs: undefined.
   */
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

function triageImportanceDotClass(importance: TriageImportance): string {
  if (importance === 'critical') return 'bg-[#ff787c]'
  if (importance === 'high') return 'bg-[#ffbf2f]'
  return 'bg-[#6f7078]'
}

export default function WatchtowerPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const folderPath = workspace?.folderPath ?? null
  const { state, tasks, problems, refresh } = useSwitchboardData(folderPath)

  const inbox = useMemo(() => filterInboxTasks(tasks), [tasks])
  const [runs, setRuns] = useState<WatchtowerRun[]>([])
  const [importResult, setImportResult] = useState<SwitchboardImportResult | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [preset, setPreset] = useState<WatchtowerReviewPresetId>('lean_code_review')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState<DraftTask>(emptyDraft)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<DraftTask>(emptyDraft)
  const [commentBody, setCommentBody] = useState('')
  const [fetchOpen, setFetchOpen] = useState(false)
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
  const inboxAttribution = useMemo(() => {
    const map = new Map<string, { run: WatchtowerRun; agent: WatchtowerRunAgent }>()
    for (const record of inbox) {
      const attribution = findTaskAttribution(record, runs)
      if (attribution) map.set(record.task.id, attribution)
    }
    return map
  }, [inbox, runs])

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

  const hasActiveRun = useMemo(
    () => runs.some((run) => run.status === 'running' || run.status === 'pending'
      || run.agents.some((agent) => agent.status === 'running' || agent.status === 'pending')),
    [runs]
  )

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
        })
        if (!started.ok) {
          notifyStartFailure('review', started.message)
          return
        }
        setSelectedRunId(started.run.runId)
        await refreshRuns()
        feedback.notify('runReview', 'success', 'Review started.')
      } catch (caught) {
        notifyStartFailure('review', caught instanceof Error ? caught.message : 'Watchtower review did not start.')
      }
    })
  }, [feedback, folderPath, notifyStartFailure, preset, refreshRuns, runAction, selectedPreset.agents, workspaceId])

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
          })
          if (!started.ok) {
            notifyStartFailure('triage', started.message)
            return
          }
          setSelectedRunId(started.run.runId)
          await refreshRuns()
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
    [feedback, folderPath, inbox, notifyStartFailure, refreshRuns, runAction, selected, workspaceId]
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

  if (!workspace) {
    return <div className={`h-full ${PANEL_BG} p-4 text-sm text-[#8a8a92]`}>Workspace not found.</div>
  }

  if (!folderPath) {
    return (
      <div className={`h-full ${PANEL_BG} p-6 text-sm text-[#8a8a92]`}>
        Choose a workspace folder to use Watchtower.
      </div>
    )
  }

  return (
    <div className={`relative flex h-full min-h-0 ${PANEL_BG} text-[#d7d7dc]`}>
      <section
        tabIndex={0}
        onKeyDown={handleInboxKeyDown}
        className="flex w-[44%] min-w-[320px] max-w-[560px] flex-col border-r border-[#1f2025] focus:outline-none"
        aria-label="Inbox"
      >
        <RunReviewSection
          preset={preset}
          onPresetChange={setPreset}
          runs={runs}
          selectedRun={selectedRun}
          selectedRunAgentOutcomes={selectedRunAgentOutcomes}
          onSelectRun={setSelectedRunId}
          onStartTriage={() => void handleStartTriage('all')}
          onStartReview={handleStartReview}
          triageDisabled={inbox.length === 0}
          isStartingReview={isPending('startReview')}
          isStartingTriage={isPending('startTriageAll')}
          statuses={feedback.statuses}
          onDismissStatus={feedback.dismiss}
          workspaceRoot={folderPath}
          workspaceId={workspaceId}
        />

        <FetchExternalSection
          open={fetchOpen}
          onToggle={() => setFetchOpen((current) => !current)}
          importResult={importResult}
          onImportGitHub={handleImportGitHub}
          onImportJira={handleImportJira}
          isImportingGitHub={isPending('importGitHub')}
          isImportingJira={isPending('importJira')}
          status={feedback.statuses.fetchExternal ?? null}
          onDismissStatus={() => feedback.dismiss('fetchExternal')}
        />

        <header className="flex items-center justify-between gap-3 border-b border-t border-[#1f2025] bg-[#0b0c0f] px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: ACCENT }}
              aria-hidden="true"
            />
            <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[#ececee]">
              Inbox
            </h2>
            <span className="shrink-0 tabular-nums text-[11px] text-[#6f7078]">{inbox.length}</span>
            <ActionStatusChip
              status={feedback.statuses.inboxList ?? null}
              onDismiss={feedback.statuses.inboxList?.tone === 'error' ? () => feedback.dismiss('inboxList') : undefined}
              className="ml-1"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleRefreshAll()}
              disabled={isPending('refresh')}
              className="interactive h-7 rounded border border-[#2a2b31] px-2 text-[11px] font-medium text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
              aria-label="Refresh inbox and runs"
              title="Refresh inbox and runs"
            >
              {isPending('refresh') ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="interactive inline-flex h-7 items-center gap-1 rounded border border-[#3a2820] bg-[#241513] px-2.5 text-[11px] font-semibold text-[#ffe2d4] hover:bg-[#2c1a18] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70"
            >
              <PlusIcon className="h-3 w-3" />
              New
            </button>
          </div>
        </header>

        {state.kind === 'error' ? (
          <Banner tone="error" message={state.message} onRetry={refresh} />
        ) : null}
        {problems.length > 0 ? (
          <Banner
            tone="warning"
            message={`${problems.length} task file${problems.length === 1 ? '' : 's'} could not be parsed. Folder reads continue.`}
          />
        ) : null}

        <ol className="flex-1 overflow-auto" aria-label="Inbox tasks">
          {state.kind === 'loading' && inbox.length === 0 ? (
            <InboxSkeleton />
          ) : inbox.length === 0 ? (
            <li className="px-3 py-6 text-[12px] leading-5 text-[#6f7078]">
              {inboxEmptyMessage(state.kind, runs)}
            </li>
          ) : (
            inbox.map((record) => (
              <InboxRow
                key={record.task.id}
                record={record}
                attribution={inboxAttribution.get(record.task.id) ?? null}
                selected={selectedId === record.task.id}
                onSelect={() => {
                  setSelectedId(record.task.id)
                  setEditing(false)
                }}
              />
            ))
          )}
        </ol>
      </section>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Selected task detail">
        {selected ? (
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
        ) : (
          <EmptyDetail />
        )}
      </section>

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
    return `Last ${verb}: ${names} failed. See the run row above for details.`
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

function shortExecutionId(executionId: string): string {
  return executionId.startsWith('exec_') ? `exec_${executionId.slice(-8)}` : executionId
}

function agentPillState(
  agent: WatchtowerRunAgent,
  outcome: AgentTaskOutcome,
  triage: boolean
): { label: string; tone: 'running' | 'done' | 'idle' | 'failed' } {
  const { count, total } = outcome
  if (triage) {
    const scope = total ?? agent.taskIds?.length ?? 0
    switch (agent.status) {
      case 'running':
        return {
          label: scope > 0 ? `triaging… ${count}/${scope}` : 'triaging…',
          tone: 'running',
        }
      case 'pending':
        return { label: 'queued', tone: 'idle' }
      case 'completed':
        if (scope === 0) return { label: 'nothing to triage', tone: 'idle' }
        if (count === 0) return { label: `0 of ${scope} triaged`, tone: 'failed' }
        if (count < scope) return { label: `triaged ${count} of ${scope}`, tone: 'done' }
        return { label: `triaged ${count} item${count === 1 ? '' : 's'}`, tone: 'done' }
      case 'failed':
        return { label: scope > 0 ? `failed after ${count}/${scope}` : 'failed', tone: 'failed' }
      case 'canceled':
        return { label: 'canceled', tone: 'idle' }
      default:
        return { label: agent.status, tone: 'idle' }
    }
  }
  switch (agent.status) {
    case 'running':
      return { label: count > 0 ? `reviewing… ${count} added` : 'reviewing…', tone: 'running' }
    case 'pending':
      return { label: 'queued', tone: 'idle' }
    case 'completed':
      return { label: count === 0 ? 'no findings' : `${count} added`, tone: 'done' }
    case 'failed':
      return { label: 'failed', tone: 'failed' }
    case 'canceled':
      return { label: 'canceled', tone: 'idle' }
    default:
      return { label: agent.status, tone: 'idle' }
  }
}

const PILL_TONE_CLASSES: Record<'running' | 'done' | 'idle' | 'failed', string> = {
  running: 'border-[#3a3426] bg-[#1d1714] text-[#f2c45f]',
  done: 'border-[#234d27] bg-[#0f1d10] text-[#9be39e]',
  idle: 'border-[#2a2b31] bg-[#111216] text-[#9a9aa2]',
  failed: 'border-[#3a2222] bg-[#1c1414] text-[#ffb3b5]',
}

function runHistoryLabel(run: WatchtowerRun, index: number): string {
  const verb = isTriageRun(run) ? 'Triage' : 'Review'
  const when = formatRelativeTime(run.createdAt)
  return `${verb} ${index + 1} · ${when}`
}

function RunReviewSection({
  preset,
  onPresetChange,
  runs,
  selectedRun,
  selectedRunAgentOutcomes,
  onSelectRun,
  onStartTriage,
  onStartReview,
  triageDisabled,
  isStartingReview,
  isStartingTriage,
  statuses,
  onDismissStatus,
  workspaceRoot,
  workspaceId,
}: {
  preset: WatchtowerReviewPresetId
  onPresetChange: (next: WatchtowerReviewPresetId) => void
  runs: WatchtowerRun[]
  selectedRun: WatchtowerRun | null
  selectedRunAgentOutcomes: Map<string, AgentTaskOutcome>
  onSelectRun: (runId: string) => void
  onStartTriage: () => void
  onStartReview: () => void
  triageDisabled: boolean
  isStartingReview: boolean
  isStartingTriage: boolean
  statuses: ActionStatusMap
  onDismissStatus: (key: string) => void
  workspaceRoot: string | null
  workspaceId: string
}) {
  const selectedPreset = WATCHTOWER_REVIEW_PRESETS.find((item) => item.id === preset) ?? WATCHTOWER_REVIEW_PRESETS[0]
  const presetAgents = Object.entries(selectedPreset.agents)
  const runStatus = statuses.runReview ?? null
  const triageRun = selectedRun ? isTriageRun(selectedRun) : false
  const terminalSessions = useTerminalSessions()
  return (
    <div className="border-b border-[#1f2025] bg-[#0b0c0f] px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: ACCENT }}
            aria-hidden="true"
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#ececee]">
            Run a review
          </span>
          <ActionStatusChip
            status={runStatus}
            onDismiss={runStatus?.tone === 'error' ? () => onDismissStatus('runReview') : undefined}
            className="ml-1"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onStartTriage}
            disabled={triageDisabled || isStartingTriage}
            className="interactive h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
            title="Run architect triage on every inbox task"
          >
            {isStartingTriage ? 'Starting…' : 'Triage inbox'}
          </button>
          <button
            type="button"
            onClick={onStartReview}
            disabled={isStartingReview || presetAgents.length === 0}
            className="interactive h-7 rounded border border-[#3a2820] bg-[#241513] px-2.5 text-[11px] font-semibold text-[#ffe2d4] hover:bg-[#2c1a18] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
            title="Start a review using the selected preset"
          >
            {isStartingReview ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        <select
          value={preset}
          onChange={(event) => onPresetChange(event.target.value as WatchtowerReviewPresetId)}
          className="h-8 rounded border border-[#2a2b31] bg-[#0d0e11] px-2 text-[12px] text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70"
          aria-label="Review preset"
        >
          {WATCHTOWER_REVIEW_PRESETS.filter((item) => item.id !== 'custom').map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        {presetAgents.length > 0 && !selectedRun ? (
          <div className="flex flex-wrap gap-1.5">
            {presetAgents.map(([specialistId, sectors]) => {
              const specialist = getSpecialistAction(specialistId as SpecialistActionId)
              const labels = (sectors ?? []).map((sector) => getWatchtowerReviewSector(sector).label)
              return (
                <span key={specialistId} className="rounded border border-[#2a2b31] bg-[#111216] px-2 py-1 text-[11px] text-[#d7d7dc]">
                  {specialist.shortLabel}: {labels.join(', ')}
                </span>
              )
            })}
          </div>
        ) : null}
      </div>
      {selectedRun ? (
        <div className="mt-3 border-t border-[#1f2025] pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6f7078]">
              {selectedRun.status === 'running' || selectedRun.status === 'pending'
                ? triageRun ? 'Active triage' : 'Active review'
                : triageRun ? 'Last triage' : 'Last review'}
            </div>
            {runs.length > 1 ? (
              <label className="relative inline-flex items-center">
                <span className="sr-only">Switch run</span>
                <select
                  value={selectedRun.runId}
                  onChange={(event) => onSelectRun(event.target.value)}
                  className="interactive h-6 max-w-[200px] truncate rounded border border-[#2a2b31] bg-[#0d0e11] py-0 pl-2 pr-6 text-[11px] tabular-nums text-[#c8c8cf] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70"
                  aria-label="Switch run"
                >
                  {runs.slice(0, 8).map((run, index) => (
                    <option key={run.runId} value={run.runId}>
                      {runHistoryLabel(run, index)}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[#6f7078]" />
              </label>
            ) : null}
          </div>
          <ul className="mt-2 space-y-1">
            {selectedRun.agents.map((agent) => {
              const outcome = selectedRunAgentOutcomes.get(agent.agentId) ?? { count: 0 }
              const pill = agentPillState(agent, outcome, triageRun)
              const executionLabel = agent.executionId ? shortExecutionId(agent.executionId) : 'launch pending'
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
              const terminalButtonLabel = terminalTabOpen ? 'Focus terminal' : 'Open terminal'
              const handleOpenTerminal = (): void => {
                if (!canOpenTerminal || !agent.executionId) return
                void import('../../utils/modelRegistry').then(({ focusOrAddAgentSessionTab }) => {
                  void focusOrAddAgentSessionTab(workspaceId, {
                    executionId: agent.executionId!,
                    fallbackName: specialistShortLabel(agent),
                  })
                })
              }
              return (
                <li key={agent.agentId}>
                  <div
                    className="grid min-w-0 gap-1 rounded border border-[#202128] bg-[#0d0e11] px-2 py-1.5"
                    title={agent.executionId ?? undefined}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[12px] text-[#d7d7dc]">{specialistShortLabel(agent)}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {canOpenTerminal ? (
                          <button
                            type="button"
                            onClick={handleOpenTerminal}
                            className="interactive inline-flex h-5 items-center gap-1 rounded border border-[#3a2820] bg-[#241513] px-1.5 text-[10.5px] font-semibold text-[#ffe2d4] hover:bg-[#2c1a18] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70"
                            title={terminalButtonLabel}
                          >
                            {terminalState.kind === 'running' ? (
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full status-dot-pulse"
                                style={{ background: '#30d158' }}
                                aria-hidden="true"
                              />
                            ) : terminalState.kind === 'exited' ? (
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ background: '#5a5a63' }}
                                aria-hidden="true"
                              />
                            ) : null}
                            {terminalButtonLabel}
                          </button>
                        ) : null}
                        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${PILL_TONE_CLASSES[pill.tone]}`}>
                          {pill.label}
                        </span>
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-[#6f7078]">
                      <span className="shrink-0">Runtime</span>
                      <span className="min-w-0 truncate font-mono tabular-nums">{executionLabel}</span>
                    </div>
                    {agent.errorMessage ? (
                      <div className="max-h-8 overflow-hidden text-[11px] leading-4 text-[#ffb3b5]">
                        {agent.errorMessage}
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : runs.length === 0 ? null : (
        <div className="mt-3 border-t border-[#1f2025] pt-3 text-[12px] text-[#6f7078]">
          No active review.
        </div>
      )}
    </div>
  )
}

function FetchExternalSection({
  open,
  onToggle,
  importResult,
  onImportGitHub,
  onImportJira,
  isImportingGitHub,
  isImportingJira,
  status,
  onDismissStatus,
}: {
  open: boolean
  onToggle: () => void
  importResult: SwitchboardImportResult | null
  onImportGitHub: () => void
  onImportJira: () => void
  isImportingGitHub: boolean
  isImportingJira: boolean
  status: ActionStatus | null
  onDismissStatus: () => void
}) {
  return (
    <div className="border-b border-[#1f2025] bg-[#0b0c0f]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="interactive flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#0e0f12]"
      >
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">Fetch external</span>
          {!open && status ? (
            <ActionStatusChip
              status={status}
              onDismiss={status.tone === 'error' ? onDismissStatus : undefined}
            />
          ) : null}
        </span>
        {open ? <MinusIcon className="h-3 w-3 text-[#6f7078]" /> : <PlusIcon className="h-3 w-3 text-[#6f7078]" />}
      </button>
      {open ? (
        <div className="px-3 pb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={onImportGitHub}
              disabled={isImportingGitHub}
              className="interactive h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#c8c8cf] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
            >
              {isImportingGitHub ? 'Fetching…' : 'Fetch GitHub'}
            </button>
            <button
              type="button"
              onClick={onImportJira}
              disabled={isImportingJira}
              className="interactive h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#c8c8cf] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
            >
              {isImportingJira ? 'Fetching…' : 'Fetch Jira'}
            </button>
            <ActionStatusChip
              status={status}
              onDismiss={status?.tone === 'error' ? onDismissStatus : undefined}
              className="ml-1"
            />
          </div>
          {importResult ? (
            <div className="mt-2 rounded border border-[#202128] bg-[#0d0e11] px-2 py-1.5 text-[11px] text-[#8a8a92]">
              {importResult.ok ? (
                <>
                  <div className="tabular-nums">
                    {importResult.provider}: created {importResult.summary.created}, updated {importResult.summary.updated}, skipped {importResult.summary.skipped}, errors {importResult.summary.errors}
                  </div>
                  {importResult.items.length > 0 ? (
                    <div className="mt-1 max-h-24 overflow-auto border-t border-[#202128] pt-1">
                      {importResult.items.slice(0, 8).map((item, index) => (
                        <div key={`${item.externalKey ?? item.externalUrl ?? index}:${index}`} className="flex min-w-0 items-center gap-2 py-0.5">
                          <span className={
                            item.status === 'created'
                              ? 'shrink-0 text-[#8fd49c]'
                              : item.status === 'error'
                                ? 'shrink-0 text-[#ff9ea0]'
                                : 'shrink-0 text-[#d8b56d]'
                          }>
                            {item.status}
                          </span>
                          <span className="truncate font-mono text-[#a1a1aa]">
                            {item.externalKey ?? item.externalUrl ?? 'unknown source'}
                          </span>
                          {item.message ? <span className="truncate text-[#6f7078]">{item.message}</span> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <span>{importResult.provider}: {importResult.message}</span>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function InboxRow({
  record,
  attribution,
  selected,
  onSelect,
}: {
  record: SwitchboardTaskRecord
  attribution: { run: WatchtowerRun; agent: WatchtowerRunAgent } | null
  selected: boolean
  onSelect: () => void
}) {
  const task = record.task
  const commentCount = task.comments.length
  const labels = task.labels.slice(0, 2)
  const triageComment = latestTriageComment(record)
  const triageImportance = parseTriageImportance(triageComment)
  const provenanceLabel = attribution
    ? `review · ${specialistShortLabel(attribution.agent)}`
    : record.task.source.type !== 'manual'
      ? sourceLabel(record)
      : null
  const descriptionPreview = task.description
    ? task.description.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim()
    : null
  const triageLabel = triageImportance
    ? `Triaged · ${triageImportance.charAt(0).toUpperCase()}${triageImportance.slice(1)}`
    : triageComment ? 'Triaged' : null
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`interactive relative flex w-full min-w-0 gap-2.5 px-3 py-2.5 text-left border-b border-[#13141a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/60 focus-visible:ring-inset ${
          selected
            ? 'bg-[#17181d] pl-[9px] text-[#ececee] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r before:bg-[#d97757]'
            : 'hover:bg-[#0e0f12] text-[#c8c8cf]'
        }`}
      >
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono tabular-nums text-[11px] text-[#8a8a92]">
              {shortIdentifier(record)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.title}</span>
            {provenanceLabel ? (
              <span className="shrink-0 rounded border border-[#2a2b31] bg-[#0d0e11] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-[#9a9aa2]">
                {provenanceLabel}
              </span>
            ) : null}
          </span>
          {descriptionPreview ? (
            <span className="block truncate text-[12px] leading-5 text-[#8a8a92]">{descriptionPreview}</span>
          ) : null}
          <span className="flex min-w-0 items-center gap-2 text-[11px] text-[#6f7078]">
            <PriorityIcon priority={task.priority} className="h-3.5 w-3.5 shrink-0 text-[#9a9aa2]" />
            {labels.length > 0 ? (
              <span className="truncate">{labels.join(' · ')}</span>
            ) : null}
            {commentCount > 0 ? (
              <span className="ml-auto flex items-center gap-1 text-[#9a9aa2]">
                <CommentIcon className="h-3 w-3 shrink-0" />
                <span className="tabular-nums">{commentCount}</span>
              </span>
            ) : null}
            {triageLabel ? (
              <span className="flex shrink-0 items-center gap-1 rounded border border-[#2a2b31] bg-[#0d0e11] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-[#9a9aa2]">
                <span className={`h-1.5 w-1.5 rounded-full ${triageImportanceDotClass(triageImportance)}`} aria-hidden="true" />
                {triageLabel}
              </span>
            ) : null}
            <span className={`shrink-0 tabular-nums ${commentCount > 0 || triageLabel ? '' : 'ml-auto'}`}>
              {formatRelativeTime(task.createdAt)}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}

function InboxSkeleton() {
  return (
    <li aria-busy="true" aria-label="Loading inbox">
      <ul className="space-y-0">
        {Array.from({ length: 5 }).map((_, idx) => (
          <li key={idx} className="border-b border-[#13141a] px-3 py-2.5">
            <div className="flex items-baseline gap-2">
              <div className="skeleton-shimmer h-2.5 w-12 rounded bg-[#13141a]" />
              <div className="skeleton-shimmer h-3 flex-1 rounded bg-[#13141a]" />
              <div className="skeleton-shimmer h-2.5 w-10 rounded bg-[#13141a]" />
            </div>
            <div className="skeleton-shimmer mt-1.5 h-2.5 w-[70%] rounded bg-[#13141a]" />
            <div className="mt-1.5 flex items-center gap-2">
              <div className="skeleton-shimmer h-2.5 w-14 rounded bg-[#13141a]" />
              <div className="skeleton-shimmer ml-auto h-2.5 w-10 rounded bg-[#13141a]" />
            </div>
          </li>
        ))}
      </ul>
    </li>
  )
}

function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[#6f7078]">
      <div className="text-[12px] uppercase tracking-[0.08em] text-[#5a5a63]">Triage</div>
      <div className="text-[13px] text-[#8a8a92]">Select an inbox task to inspect, edit, comment, or promote.</div>
    </div>
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
  const anyDetailMutation = isEditing || isPromoting || isCanceling || isTriaging
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#1f2025] px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-[#6f7078]">
            <span className="font-mono tabular-nums text-[12px] text-[#9a9aa2]">{shortIdentifier(record)}</span>
            <span>·</span>
            <span>Inbox</span>
            <span>·</span>
            <span className="tabular-nums">{formatRelativeTime(task.createdAt)}</span>
          </div>
          {editing ? (
            <input
              value={editForm.title}
              onChange={(event) => onEditFormChange({ ...editForm, title: event.target.value })}
              className="mt-2 block w-full bg-transparent text-[18px] font-semibold text-[#ececee] outline-none focus:border-b focus:border-[#ececee]/40"
            />
          ) : (
            <h3 className="mt-2 truncate text-[18px] font-semibold text-[#ececee]">{task.title}</h3>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <ActionStatusChip
            status={detailStatus}
            onDismiss={detailStatus?.tone === 'error' ? onDismissDetailStatus : undefined}
          />
          {editing ? (
            <>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={isEditing}
                className="interactive h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSaveEdit}
                disabled={isEditing}
                className="interactive h-7 rounded border border-[#ececee] bg-[#ececee] px-2.5 text-[11px] font-semibold text-[#08090b] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#ececee]/60 disabled:opacity-50"
              >
                {isEditing ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onStartEdit}
                disabled={anyDetailMutation}
                className="interactive h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onCancelTask}
                disabled={anyDetailMutation}
                className="interactive h-7 rounded border border-[#3a2222] px-2.5 text-[11px] font-medium text-[#ffb3b5] hover:bg-[#1c1414] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#ff787c]/60 disabled:opacity-50"
              >
                {isCanceling ? 'Canceling…' : 'Cancel task'}
              </button>
              <button
                type="button"
                onClick={onTriageTask}
                disabled={anyDetailMutation}
                className="interactive h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
                title="Run architect triage on this task"
              >
                {isTriaging ? 'Starting…' : 'Triage task'}
              </button>
              <button
                type="button"
                onClick={onPromote}
                disabled={anyDetailMutation}
                className="interactive h-7 rounded border border-[#3a2820] bg-[#2c1a18] px-2.5 text-[11px] font-semibold text-[#ffe2d4] hover:bg-[#3a2421] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
              >
                {isPromoting ? 'Promoting…' : 'Promote to Switchboard'}
              </button>
            </>
          )}
        </div>
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
          {editing ? (
            <input
              value={editForm.identifier}
              onChange={(event) => onEditFormChange({ ...editForm, identifier: event.target.value })}
              className="block w-48 rounded border border-[#2a2b31] bg-[#0d0e11] px-2 py-1 font-mono tabular-nums text-[12px] text-[#ececee]"
            />
          ) : (
            <span className="font-mono tabular-nums text-[12px] text-[#d7d7dc]">{task.identifier}</span>
          )}
        </PropertyRow>
        <PropertyRow label="Priority">
          {editing ? (
            <select
              value={editForm.priority == null ? '' : String(editForm.priority)}
              onChange={(event) => {
                const v = event.target.value
                onEditFormChange({ ...editForm, priority: v === '' ? null : Number(v) })
              }}
              className="rounded border border-[#2a2b31] bg-[#0d0e11] px-2 py-1 text-[12px] text-[#ececee]"
            >
              <option value="">No priority</option>
              <option value="0">Urgent</option>
              <option value="1">High</option>
              <option value="2">Medium</option>
              <option value="3">Low</option>
            </select>
          ) : (
            <span className="flex items-center gap-2 text-[12px] text-[#d7d7dc]">
              <PriorityIcon priority={task.priority} className="h-3.5 w-3.5 shrink-0 text-[#9a9aa2]" />
              {priorityLabel(task.priority)}
            </span>
          )}
        </PropertyRow>
        <PropertyRow label="Labels">
          {editing ? (
            <input
              value={editForm.labels}
              onChange={(event) => onEditFormChange({ ...editForm, labels: event.target.value })}
              placeholder="bug, auth"
              className="block w-full max-w-md rounded border border-[#2a2b31] bg-[#0d0e11] px-2 py-1 text-[12px] text-[#ececee]"
            />
          ) : task.labels.length > 0 ? (
            <span className="flex flex-wrap gap-1.5">
              {task.labels.map((label) => (
                <span key={label} className="rounded border border-[#2a2b31] bg-[#111216] px-2 py-0.5 text-[11px] text-[#d7d7dc]">
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
        <PropertyRow label="Created">
          <span className="text-[12px] text-[#9a9aa2]">{task.createdAt}</span>
        </PropertyRow>

        {triageComment ? (
          <div className="mt-4 rounded border border-[#2a2b31] bg-[#0d0e11] px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#d7d7dc]">
                <SpecialistActionIcon icon="architecture" className="h-3.5 w-3.5 text-[#9a9aa2]" />
                Architect triage
              </span>
              <span className="flex items-center gap-1 rounded border border-[#2a2b31] bg-[#111216] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-[#9a9aa2]">
                <span className={`h-1.5 w-1.5 rounded-full ${triageImportanceDotClass(triageImportance)}`} aria-hidden="true" />
                {triageImportance ?? 'triaged'}
              </span>
              <span className="ml-auto text-[11px] tabular-nums text-[#6f7078]">{formatRelativeTime(triageComment.createdAt)}</span>
            </div>
            <div className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-[#d7d7dc]">{triageComment.body}</div>
          </div>
        ) : null}

        <div className={`mt-4 ${SECTION_DIVIDER} pt-4`}>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">Description</div>
          {editing ? (
            <textarea
              value={editForm.description}
              onChange={(event) => onEditFormChange({ ...editForm, description: event.target.value })}
              className="min-h-[140px] w-full rounded border border-[#2a2b31] bg-[#0d0e11] p-2 text-[13px] leading-6 text-[#ececee] outline-none focus:border-[#ececee]/40"
            />
          ) : task.description.trim() ? (
            <div className="whitespace-pre-wrap text-[13px] leading-6 text-[#d7d7dc]">{task.description}</div>
          ) : (
            <div className="text-[12px] text-[#6f7078]">No description provided.</div>
          )}
        </div>

        <CommentsSection record={record} />
      </div>

      <footer className="border-t border-[#1f2025] px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="watchtower-comment-input" className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">
            Add comment
          </label>
          <ActionStatusChip
            status={commentStatus}
            onDismiss={commentStatus?.tone === 'error' ? onDismissCommentStatus : undefined}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <textarea
            id="watchtower-comment-input"
            value={commentBody}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Note for triage, link a finding, or capture context..."
            rows={2}
            className="min-h-[44px] flex-1 rounded border border-[#2a2b31] bg-[#0d0e11] p-2 text-[13px] leading-6 text-[#ececee] outline-none focus:border-[#ececee]/40"
          />
          <button
            type="button"
            onClick={onAddComment}
            disabled={isCommenting || !commentBody.trim()}
            className="interactive h-9 self-end rounded border border-[#2a2b31] px-3 text-[12px] font-semibold text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d97757]/70 disabled:opacity-50"
          >
            {isCommenting ? 'Sending…' : 'Comment'}
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

function CommentsSection({ record }: { record: SwitchboardTaskRecord }) {
  const comments = record.task.comments
  return (
    <div className={`mt-4 ${SECTION_DIVIDER} pt-4`}>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">
        Activity ({comments.length})
      </div>
      {comments.length === 0 ? (
        <div className="text-[12px] text-[#6f7078]">No comments yet.</div>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="border-l border-[#2a2b31] pl-3">
              <div className="flex items-baseline gap-2 text-[11.5px] text-[#9a9aa2]">
                <span className="font-medium text-[#d7d7dc]">{comment.author.name ?? comment.author.type}</span>
                <span className="text-[#6f7078]">·</span>
                <span className="uppercase tracking-[0.06em] text-[#6f7078]">{comment.kind}</span>
                <span className="text-[#6f7078]">·</span>
                <span className="tabular-nums">{formatRelativeTime(comment.createdAt)}</span>
              </div>
              <div className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-[#d7d7dc]">{comment.body}</div>
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
  const inputClass = 'block w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2 text-[13px] text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#d97757]/70'
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
            <select
              value={draft.priority == null ? '' : String(draft.priority)}
              onChange={(event) => {
                const v = event.target.value
                onChange({ ...draft, priority: v === '' ? null : Number(v) })
              }}
              className={`${inputClass} h-9 py-0`}
            >
              <option value="">No priority</option>
              <option value="0">Urgent</option>
              <option value="1">High</option>
              <option value="2">Medium</option>
              <option value="3">Low</option>
            </select>
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
          accent="copper"
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
  const toneClass =
    tone === 'error'
      ? 'border-[#3a2222] bg-[#1c1414] text-[#ffb3b5]'
      : 'border-[#3a3426] bg-[#1d1714] text-[#f2c45f]'
  const retryRing = tone === 'error' ? 'focus-visible:ring-[#ff787c]/50' : 'focus-visible:ring-[#f2c45f]/50'
  return (
    <div className={`flex items-center justify-between gap-3 border-b ${toneClass} px-3 py-2 text-[12px]`}>
      <span className="min-w-0 truncate">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={`interactive shrink-0 rounded border border-current bg-transparent px-2 py-0.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-1 ${retryRing}`}
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
