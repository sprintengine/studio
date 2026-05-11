import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Field, Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
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
import { CommentIcon, PriorityIcon, SpecialistActionIcon } from '../AppIcons'
import {
  formatRelativeTime,
  priorityLabel,
  shortIdentifier,
  sourceLabel,
  useSwitchboardData,
} from '../../utils/switchboardBoard'
import { filterInboxTasks } from '../../utils/watchtower'
import { publishDiagnosticSync } from '../../utils/diagnostics'

const PANEL_BG = 'bg-[#08090b]'
const SECTION_DIVIDER = 'border-t border-[#1f2025]'
const ACCENT = '#d97757'

function isEditableInboxTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

type ToastTone = 'info' | 'success' | 'error'

type Toast = {
  tone: ToastTone
  message: string
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
  const externalKey = record.task.source.externalKey ?? null
  const externalId = record.task.source.externalId ?? null
  for (const run of runs) {
    if (externalKey?.startsWith(`${run.runId}:`)) {
      const remainder = externalKey.slice(run.runId.length + 1)
      const agent = run.agents.find((candidate) => remainder.startsWith(`${candidate.agentId}:`)
        || remainder.startsWith(`${sanitizeIdentityPart(candidate.agentId)}:`))
      if (agent) return { run, agent }
    }
    if (externalId?.startsWith(`${run.runId}_`)) {
      const remainder = externalId.slice(run.runId.length + 1)
      const agent = run.agents.find((candidate) => remainder.startsWith(`${sanitizeIdentityPart(candidate.agentId)}_`))
      if (agent) return { run, agent }
    }
  }
  return null
}

function countTasksPerAgent(run: WatchtowerRun, tasks: SwitchboardTaskRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const agent of run.agents) counts.set(agent.agentId, 0)
  for (const record of tasks) {
    const attribution = findTaskAttribution(record, [run])
    if (!attribution) continue
    counts.set(attribution.agent.agentId, (counts.get(attribution.agent.agentId) ?? 0) + 1)
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
  if (message.toLowerCase().includes('runner is paused or disabled')) {
    return 'Watchtower uses the Switchboard runner. Start or resume the runner from the Switchboard board, then try again.'
  }
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
  const { state, tasks, problems, refresh, switchboardRoot } = useSwitchboardData(folderPath)

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
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [fetchOpen, setFetchOpen] = useState(false)

  useEffect(() => {
    if (!toast) return
    if (toast.tone === 'error') return
    const handle = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(handle)
  }, [toast])

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
  const selectedRunAgentCounts = useMemo(
    () => (selectedRun ? countTasksPerAgent(selectedRun, tasks) : new Map<string, number>()),
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

  const showToast = useCallback((tone: ToastTone, message: string) => {
    setToast({ tone, message })
  }, [])

  const notifyStartFailure = useCallback((kind: WatchtowerStartKind, message: string) => {
    const userMessage = watchtowerStartErrorMessage(message)
    showToast('error', userMessage)
    publishDiagnosticSync({
      level: 'error',
      source: 'workspace',
      title: kind === 'review' ? 'Watchtower review did not start' : 'Watchtower triage did not start',
      message: userMessage,
      details: message === userMessage ? undefined : message,
      workspaceId,
      workspaceName: workspace?.name,
    })
  }, [showToast, workspace?.name, workspaceId])

  const refreshRuns = useCallback(async () => {
    if (!folderPath) {
      setRuns([])
      return
    }
    const result = await window.api.listWatchtowerRuns(folderPath)
    if (!result.ok) {
      showToast('error', result.message)
      return
    }
    setRuns(result.runs)
    setSelectedRunId((current) => current && result.runs.some((run) => run.runId === current)
      ? current
      : result.runs[0]?.runId ?? null)
  }, [folderPath, showToast])

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
    await Promise.all([refresh(), refreshRuns()])
  }, [refresh, refreshRuns])

  const selectedPreset = useMemo(
    () => WATCHTOWER_REVIEW_PRESETS.find((item) => item.id === preset) ?? WATCHTOWER_REVIEW_PRESETS[0],
    [preset]
  )

  const handleStartReview = useCallback(async () => {
    if (!folderPath) return
    const hasAgents = Object.values(selectedPreset.agents).some((sectors) => (sectors ?? []).length > 0)
    if (!hasAgents) {
      showToast('error', 'Select a preset with at least one review agent.')
      return
    }
    setBusy(true)
    try {
      const started = await window.api.startWatchtowerReview({
        workspaceRoot: folderPath,
        preset,
      })
      if (!started.ok) {
        notifyStartFailure('review', started.message)
        return
      }
      setSelectedRunId(started.run.runId)
      await refreshRuns()
      showToast('success', 'Watchtower review started.')
    } catch (caught) {
      notifyStartFailure('review', caught instanceof Error ? caught.message : 'Watchtower review did not start.')
    } finally {
      setBusy(false)
    }
  }, [folderPath, notifyStartFailure, preset, refreshRuns, selectedPreset.agents, showToast])

  const handleStartTriage = useCallback(async (scope: 'all' | 'selected') => {
    if (!folderPath) return
    const scopedTasks = scope === 'selected' ? (selected ? [selected] : []) : inbox
    if (scopedTasks.length === 0) {
      showToast('info', scope === 'selected' ? 'Select an inbox task to triage.' : 'There are no inbox tasks to triage.')
      return
    }

    setBusy(true)
    try {
      const started = await window.api.startWatchtowerTriage({
        workspaceRoot: folderPath,
        scope: scope === 'selected' ? 'selected' : 'all',
        taskId: scope === 'selected' ? scopedTasks[0]?.task.id : undefined,
      })
      if (!started.ok) {
        notifyStartFailure('triage', started.message)
        return
      }
      setSelectedRunId(started.run.runId)
      await refreshRuns()
      showToast('success', scope === 'selected' ? 'Architect triage started for this task.' : 'Architect inbox triage started.')
    } catch (caught) {
      notifyStartFailure('triage', caught instanceof Error ? caught.message : 'Watchtower triage did not start.')
    } finally {
      setBusy(false)
    }
  }, [folderPath, inbox, notifyStartFailure, refreshRuns, selected, showToast])

  const handleImportGitHub = useCallback(async () => {
    if (!folderPath) return
    setBusy(true)
    try {
      const result = await window.api.importGitHubIssuesToWatchtower(folderPath)
      setImportResult(result)
      if (!result.ok) {
        showToast(result.unavailable ? 'info' : 'error', result.message)
        return
      }
      await refresh()
      showToast('success', `GitHub import: ${result.summary.created} created, ${result.summary.skipped} skipped.`)
    } finally {
      setBusy(false)
    }
  }, [folderPath, refresh, showToast])

  const handleImportJira = useCallback(async () => {
    if (!folderPath) return
    setBusy(true)
    try {
      const result = await window.api.importJiraIssuesToWatchtower(folderPath)
      setImportResult(result)
      showToast(result.ok ? 'success' : result.unavailable ? 'info' : 'error', result.ok
        ? `Jira import: ${result.summary.created} created, ${result.summary.skipped} skipped.`
        : result.message)
      if (result.ok) await refresh()
    } finally {
      setBusy(false)
    }
  }, [folderPath, refresh, showToast])

  const handleCreate = useCallback(async () => {
    if (!folderPath || !draft.title.trim()) return
    setBusy(true)
    try {
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
        showToast('error', result.message)
        return
      }
      setSelectedId(result.record.task.id)
      setDraft(emptyDraft)
      setCreateOpen(false)
      await refresh()
      showToast('success', 'Task added to inbox.')
    } finally {
      setBusy(false)
    }
  }, [draft, folderPath, refresh, showToast])

  const handlePromote = useCallback(async () => {
    if (!folderPath || !selected) return
    setBusy(true)
    try {
      const result = await window.api.promoteSwitchboardInboxTask({
        workspaceRoot: folderPath,
        id: selected.task.id,
      })
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      await refresh()
      showToast('success', 'Promoted to Switchboard todo.')
    } finally {
      setBusy(false)
    }
  }, [folderPath, refresh, selected, showToast])

  const handleCancel = useCallback(async () => {
    if (!folderPath || !selected) return
    setBusy(true)
    try {
      const result = await window.api.cancelSwitchboardTask({
        workspaceRoot: folderPath,
        id: selected.task.id,
      })
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      await refresh()
      showToast('info', 'Task canceled.')
    } finally {
      setBusy(false)
    }
  }, [folderPath, refresh, selected, showToast])

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
    setBusy(true)
    try {
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
        showToast('error', result.message)
        return
      }
      setEditing(false)
      await refresh()
      showToast('success', 'Task updated.')
    } finally {
      setBusy(false)
    }
  }, [editForm, folderPath, refresh, selected, showToast])

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
          selectedRunAgentCounts={selectedRunAgentCounts}
          onSelectRun={setSelectedRunId}
          onStartTriage={() => void handleStartTriage('all')}
          onStartReview={handleStartReview}
          triageDisabled={busy || inbox.length === 0}
          busy={busy}
        />

        <FetchExternalSection
          open={fetchOpen}
          onToggle={() => setFetchOpen((current) => !current)}
          importResult={importResult}
          onImportGitHub={handleImportGitHub}
          onImportJira={handleImportJira}
          busy={busy}
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
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleRefreshAll()}
              disabled={busy}
              className="h-7 rounded border border-[#2a2b31] px-2 text-[11px] font-medium text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee]"
              aria-label="Refresh inbox"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="h-7 rounded border border-[#3a2820] bg-[#241513] px-2.5 text-[11px] font-semibold text-[#ffe2d4] hover:bg-[#2c1a18]"
            >
              + New
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
            <li className="px-3 py-3 text-[12px] text-[#6f7078]">Loading inbox...</li>
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
            busy={busy}
          />
        ) : (
          <EmptyDetail switchboardRoot={switchboardRoot} />
        )}
      </section>

      {createOpen ? (
        <CreateInboxDialog
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

function inboxEmptyMessage(stateKind: 'idle' | 'loading' | 'ready' | 'error', runs: WatchtowerRun[]): string {
  if (stateKind !== 'ready') return 'No inbox tasks yet.'
  if (runs.length === 0) return 'Inbox empty. Run a review or fetch issues.'
  const activeRun = runs.find((run) => run.status === 'running' || run.status === 'pending'
    || run.agents.some((agent) => agent.status === 'running' || agent.status === 'pending'))
  if (activeRun) return 'Reviewers running. Tasks land here as each one finds something.'
  const lastRun = runs[0]
  const failedAgents = lastRun?.agents.filter((agent) => agent.status === 'failed') ?? []
  if (failedAgents.length > 0) {
    const names = failedAgents.map((agent) => specialistShortLabel(agent)).join(', ')
    return `Last review: ${names} failed. See the run row above for details.`
  }
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

function agentPillState(agent: WatchtowerRunAgent, addedCount: number): { label: string; tone: 'running' | 'done' | 'idle' | 'failed' } {
  switch (agent.status) {
    case 'running':
      return { label: addedCount > 0 ? `reviewing… ${addedCount} added` : 'reviewing…', tone: 'running' }
    case 'pending':
      return { label: 'queued', tone: 'idle' }
    case 'completed':
      return { label: addedCount === 0 ? 'no findings' : `${addedCount} added`, tone: 'done' }
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

function RunReviewSection({
  preset,
  onPresetChange,
  runs,
  selectedRun,
  selectedRunAgentCounts,
  onSelectRun,
  onStartTriage,
  onStartReview,
  triageDisabled,
  busy,
}: {
  preset: WatchtowerReviewPresetId
  onPresetChange: (next: WatchtowerReviewPresetId) => void
  runs: WatchtowerRun[]
  selectedRun: WatchtowerRun | null
  selectedRunAgentCounts: Map<string, number>
  onSelectRun: (runId: string) => void
  onStartTriage: () => void
  onStartReview: () => void
  triageDisabled: boolean
  busy: boolean
}) {
  const selectedPreset = WATCHTOWER_REVIEW_PRESETS.find((item) => item.id === preset) ?? WATCHTOWER_REVIEW_PRESETS[0]
  const presetAgents = Object.entries(selectedPreset.agents)
  return (
    <div className="border-b border-[#1f2025] bg-[#0b0c0f] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">Run a review</div>
          <div className="mt-1 truncate text-[12px] text-[#c8c8cf]">{selectedPreset.description}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onStartTriage}
            disabled={triageDisabled}
            className="h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
          >
            {busy ? 'Starting...' : 'Triage inbox'}
          </button>
          <button
            type="button"
            onClick={onStartReview}
            disabled={busy || presetAgents.length === 0}
            className="h-7 rounded border border-[#3a2820] bg-[#241513] px-2.5 text-[11px] font-semibold text-[#ffe2d4] hover:bg-[#2c1a18] disabled:opacity-50"
          >
            {busy ? 'Starting...' : 'Start'}
          </button>
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        <select
          value={preset}
          onChange={(event) => onPresetChange(event.target.value as WatchtowerReviewPresetId)}
          className="h-8 rounded border border-[#2a2b31] bg-[#0d0e11] px-2 text-[12px] text-[#ececee]"
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
              {selectedRun.status === 'running'
                ? 'Active review'
                : 'Last review'}
            </div>
            {runs.length > 1 ? (
              <select
                value={selectedRun.runId}
                onChange={(event) => onSelectRun(event.target.value)}
                className="h-6 max-w-[180px] truncate rounded border border-[#2a2b31] bg-[#0d0e11] px-1.5 font-mono text-[11px] text-[#c8c8cf]"
                aria-label="Switch run"
              >
                {runs.slice(0, 8).map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.runId}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <ul className="mt-2 space-y-1">
            {selectedRun.agents.map((agent) => {
              const added = selectedRunAgentCounts.get(agent.agentId) ?? 0
              const pill = agentPillState(agent, added)
              const executionLabel = agent.executionId ? shortExecutionId(agent.executionId) : 'launch pending'
              return (
                <li
                  key={agent.agentId}
                >
                  <div
                    className="grid min-w-0 gap-1 rounded border border-[#202128] bg-[#0d0e11] px-2 py-1.5"
                    title={agent.executionId ?? undefined}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[12px] text-[#d7d7dc]">{specialistShortLabel(agent)}</span>
                      <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${PILL_TONE_CLASSES[pill.tone]}`}>
                        {pill.label}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-[#6f7078]">
                      <span className="shrink-0">Runtime</span>
                      <span className="min-w-0 truncate font-mono">{executionLabel}</span>
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
  busy,
}: {
  open: boolean
  onToggle: () => void
  importResult: SwitchboardImportResult | null
  onImportGitHub: () => void
  onImportJira: () => void
  busy: boolean
}) {
  return (
    <div className="border-b border-[#1f2025] bg-[#0b0c0f]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#0e0f12]"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">Fetch external</span>
        <span className="text-[11px] text-[#6f7078]">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <div className="px-3 pb-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onImportGitHub}
              disabled={busy}
              className="h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#c8c8cf] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
            >
              Fetch GitHub
            </button>
            <button
              type="button"
              onClick={onImportJira}
              disabled={busy}
              className="h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#c8c8cf] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
            >
              Fetch Jira
            </button>
          </div>
          {importResult ? (
            <div className="mt-2 rounded border border-[#202128] bg-[#0d0e11] px-2 py-1.5 text-[11px] text-[#8a8a92]">
              {importResult.ok ? (
                <>
                  <div>
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
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`relative flex w-full min-w-0 gap-2.5 px-3 py-2.5 text-left border-b border-[#13141a] transition-colors ${
          selected
            ? 'bg-[#17181d] pl-[9px] text-[#ececee] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r before:bg-[#d97757]'
            : 'hover:bg-[#0e0f12] text-[#c8c8cf]'
        }`}
      >
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={`shrink-0 font-mono tabular-nums text-[11px] ${selected ? 'text-[#ffd6c2]' : 'text-[#8a8a92]'}`}
            >
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
            {triageComment ? (
              <span className="flex shrink-0 items-center gap-1 rounded border border-[#2a2b31] bg-[#0d0e11] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-[#9a9aa2]">
                <span className={`h-1.5 w-1.5 rounded-full ${triageImportanceDotClass(triageImportance)}`} aria-hidden="true" />
                Triaged
              </span>
            ) : null}
            <span className={`shrink-0 tabular-nums ${commentCount > 0 ? '' : 'ml-auto'}`}>
              {formatRelativeTime(task.createdAt)}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}

function EmptyDetail({ switchboardRoot }: { switchboardRoot: string | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[#6f7078]">
      <div className="text-[12px] uppercase tracking-[0.08em] text-[#5a5a63]">Triage</div>
      <div className="text-[13px] text-[#8a8a92]">Select an inbox task to inspect, edit, comment, or promote.</div>
      {switchboardRoot ? (
        <div className="font-mono text-[11px] text-[#5a5a63]">{switchboardRoot}</div>
      ) : null}
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
  busy,
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
  busy: boolean
}) {
  const task = record.task
  const triageComment = latestTriageComment(record)
  const triageImportance = parseTriageImportance(triageComment)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#1f2025] px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-[#6f7078]">
            <span className="font-mono tabular-nums text-[12px] text-[#ffd6c2]">{shortIdentifier(record)}</span>
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
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {editing ? (
            <>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={busy}
                className="h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSaveEdit}
                disabled={busy}
                className="h-7 rounded border border-[#ececee] bg-[#ececee] px-2.5 text-[11px] font-semibold text-[#08090b] disabled:opacity-50"
              >
                Save
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onStartEdit}
                disabled={busy}
                className="h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#9a9aa2] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onCancelTask}
                disabled={busy}
                className="h-7 rounded border border-[#3a2222] px-2.5 text-[11px] font-medium text-[#ffb3b5] hover:bg-[#1c1414] disabled:opacity-50"
              >
                Cancel task
              </button>
              <button
                type="button"
                onClick={onTriageTask}
                disabled={busy}
                className="h-7 rounded border border-[#2a2b31] px-2.5 text-[11px] font-medium text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee] disabled:opacity-50"
              >
                Triage task
              </button>
              <button
                type="button"
                onClick={onPromote}
                disabled={busy}
                className="h-7 rounded border border-[#3a2820] bg-[#2c1a18] px-2.5 text-[11px] font-semibold text-[#ffe2d4] hover:bg-[#3a2421] disabled:opacity-50"
              >
                Promote to Switchboard
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
            <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-6 text-[#d7d7dc]">{triageComment.body}</pre>
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
            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-6 text-[#d7d7dc]">{task.description}</pre>
          ) : (
            <div className="text-[12px] text-[#6f7078]">No description provided.</div>
          )}
        </div>

        <CommentsSection record={record} />
      </div>

      <footer className="border-t border-[#1f2025] px-5 py-3">
        <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">
          Add comment
        </label>
        <div className="mt-2 flex gap-2">
          <textarea
            value={commentBody}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Note for triage, link a finding, or capture context..."
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
              <pre className="mt-1 whitespace-pre-wrap font-sans text-[13px] leading-6 text-[#d7d7dc]">{comment.body}</pre>
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
    <div className={`pointer-events-none absolute bottom-3 right-3 max-w-[420px] rounded border px-3 py-1.5 text-[12px] leading-5 ${cls}`}>
      {toast.message}
    </div>
  )
}
