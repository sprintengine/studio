import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  SWARM_REVIEW_PRESETS,
  getSwarmReviewSector,
  type SwarmReviewPresetId,
} from '../../utils/swarmReview'
import { buildWatchtowerStartupPrompt } from '../../utils/watchtowerPrompt'
import { getSpecialistAction } from '../../specialists/specialistActions'
import { focusOrAddAgentTab } from '../../utils/modelRegistry'
import { prependAgentIdentifier } from '../../utils/agentPrompt'
import type { AgentState, SpecialistActionId, SwarmReviewSectorId } from '../../types/workspace'
import type {
  SwitchboardTaskRecord,
  WatchtowerOutputValidationResult,
  WatchtowerRun,
  WatchtowerRunAgent,
} from '../../../../shared/switchboard'
import {
  formatRelativeTime,
  priorityLabel,
  priorityToneClass,
  shortIdentifier,
  sourceLabel,
  useSwitchboardData,
} from '../../utils/switchboardBoard'
import { filterInboxTasks } from '../../utils/watchtower'

const PANEL_BG = 'bg-[#08090b]'
const ROW_DIVIDER = 'border-b border-[#1c1d22]'
const SECTION_DIVIDER = 'border-t border-[#1f2025]'
const ACCENT = '#d97757'

type ToastTone = 'info' | 'success' | 'error'

type Toast = {
  tone: ToastTone
  message: string
}

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

function pathSeparatorFor(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function joinPath(parent: string, child: string): string {
  const separator = pathSeparatorFor(parent)
  return `${parent}${parent.endsWith(separator) ? '' : separator}${child}`
}

type SelectedWatchtowerAgent = {
  agentId: string
  specialistId: SpecialistActionId
  sectors: SwarmReviewSectorId[]
  outputDirectory: string
  reportPath: string
}

export default function WatchtowerPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const folderPath = workspace?.folderPath ?? null
  const { state, tasks, problems, refresh, switchboardRoot } = useSwitchboardData(folderPath)

  const inbox = useMemo(() => filterInboxTasks(tasks), [tasks])
  const [runs, setRuns] = useState<WatchtowerRun[]>([])
  const [invalidOutputs, setInvalidOutputs] = useState<Record<string, Extract<WatchtowerOutputValidationResult, { ok: true }>['invalid']>>({})
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [preset, setPreset] = useState<SwarmReviewPresetId>('lean_code_review')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState<DraftTask>(emptyDraft)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<DraftTask>(emptyDraft)
  const [commentBody, setCommentBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)

  useEffect(() => {
    if (!toast) return
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

  const showToast = useCallback((tone: ToastTone, message: string) => {
    setToast({ tone, message })
  }, [])

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

  const handleRefreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshRuns()])
  }, [refresh, refreshRuns])

  const selectedPreset = useMemo(
    () => SWARM_REVIEW_PRESETS.find((item) => item.id === preset) ?? SWARM_REVIEW_PRESETS[0],
    [preset]
  )

  const handleStartReview = useCallback(async () => {
    if (!folderPath) return
    const runNonce = crypto.randomUUID().slice(0, 8)
    const agents = Object.entries(selectedPreset.agents)
      .map(([specialistId, sectors]) => ({
        specialistId: specialistId as SpecialistActionId,
        sectors: (sectors ?? []) as SwarmReviewSectorId[],
      }))
      .filter((agent) => agent.sectors.length > 0)
    if (agents.length === 0) {
      showToast('error', 'Select a preset with at least one review agent.')
      return
    }
    setBusy(true)
    try {
      const runAgents: WatchtowerRunAgent[] = agents.map((agent) => {
        const agentId = `watchtower-${runNonce}-${agent.specialistId}`
        return {
          agentId,
          specialistId: agent.specialistId,
          status: 'running',
          outputDir: `outputs/${agentId}`,
          reportPath: `reports/${agentId}.md`,
        }
      })
      const created = await window.api.createWatchtowerRun({
        workspaceRoot: folderPath,
        preset,
        status: 'running',
        agents: runAgents,
      })
      if (!created.ok) {
        showToast('error', created.message)
        return
      }
      const root = switchboardRoot ?? joinPath(joinPath(folderPath, '.multi-code'), 'switchboard')
      const runRoot = joinPath(joinPath(root, 'watchtower-runs'), created.run.runId)
      const selectedAgents: SelectedWatchtowerAgent[] = agents.map((agent) => {
        const agentId = `watchtower-${runNonce}-${agent.specialistId}`
        return {
          agentId,
          specialistId: agent.specialistId,
          sectors: agent.sectors,
          outputDirectory: joinPath(joinPath(runRoot, 'outputs'), agentId),
          reportPath: joinPath(joinPath(runRoot, 'reports'), `${agentId}.md`),
        }
      })
      for (const reviewAgent of selectedAgents) {
        const specialist = getSpecialistAction(reviewAgent.specialistId)
        const prompt = buildWatchtowerStartupPrompt({
          run: created.run,
          agent: reviewAgent,
          workspaceRoot: folderPath,
        })
        const agentPatch: Partial<AgentState> = {
          name: specialist.shortLabel,
          kind: 'swarm_review',
          specialistId: reviewAgent.specialistId,
          cli: 'codex',
          cliPermissionPreset: 'default',
          cliStartupPrompt: prependAgentIdentifier(prompt, specialist.shortLabel, specialist.shortLabel),
          watchtowerRunId: created.run.runId,
          cliStartRequested: true,
          cliOnboardingPromptSent: false,
          cliHasLaunched: false,
          cliResumeAvailable: false,
          cliSessionId: crypto.randomUUID(),
        }
        updateAgent(workspaceId, reviewAgent.agentId, agentPatch)
        focusOrAddAgentTab(workspaceId, reviewAgent.agentId, specialist.shortLabel)
      }
      setSelectedRunId(created.run.runId)
      await refreshRuns()
      showToast('success', 'Watchtower review started.')
    } finally {
      setBusy(false)
    }
  }, [folderPath, preset, refreshRuns, selectedPreset.agents, showToast, switchboardRoot, updateAgent, workspaceId])

  const handleIngestRun = useCallback(async () => {
    if (!folderPath || !selectedRun) return
    setBusy(true)
    try {
      const result = await window.api.ingestWatchtowerOutputs({ workspaceRoot: folderPath, runId: selectedRun.runId })
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      setInvalidOutputs((current) => ({ ...current, [selectedRun.runId]: result.invalid }))
      await Promise.all([refresh(), refreshRuns()])
      showToast('success', `Ingested ${result.summary.created}; skipped ${result.summary.skipped}; invalid ${result.summary.invalid}.`)
    } finally {
      setBusy(false)
    }
  }, [folderPath, refresh, refreshRuns, selectedRun, showToast])

  const handleValidateRun = useCallback(async () => {
    if (!folderPath || !selectedRun) return
    setBusy(true)
    try {
      const result = await window.api.validateWatchtowerOutputs({ workspaceRoot: folderPath, runId: selectedRun.runId })
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      setInvalidOutputs((current) => ({ ...current, [selectedRun.runId]: result.invalid }))
      await refreshRuns()
      showToast('info', `Validated ${result.valid.length}; invalid ${result.invalid.length}.`)
    } finally {
      setBusy(false)
    }
  }, [folderPath, refreshRuns, selectedRun, showToast])

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
        className="flex w-[44%] min-w-[320px] max-w-[560px] flex-col border-r border-[#1f2025]"
        aria-label="Watchtower inbox"
      >
        <header className="flex items-center justify-between gap-3 border-b border-[#1f2025] px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: ACCENT }}
              aria-hidden="true"
            />
            <h2 className="truncate text-[12px] font-semibold uppercase tracking-[0.08em] text-[#ececee]">
              Watchtower Inbox
            </h2>
            <span className="shrink-0 text-[11px] text-[#6f7078]">{inbox.length}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleRefreshAll()}
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

        <ReviewRunSection
          preset={preset}
          onPresetChange={setPreset}
          runs={runs}
          selectedRun={selectedRun}
          invalidOutputs={selectedRun ? invalidOutputs[selectedRun.runId] ?? [] : []}
          onSelectRun={setSelectedRunId}
          onValidateRun={handleValidateRun}
          onStartReview={handleStartReview}
          onIngestRun={handleIngestRun}
          busy={busy}
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

        <ol className="flex-1 overflow-auto" aria-label="Inbox tasks">
          {state.kind === 'loading' && inbox.length === 0 ? (
            <li className="px-3 py-3 text-[12px] text-[#6f7078]">Loading inbox...</li>
          ) : inbox.length === 0 ? (
            <li className="px-3 py-6 text-[12px] text-[#6f7078]">
              {state.kind === 'ready'
                ? 'Inbox is empty. Create a task or run a Watchtower review.'
                : 'No inbox tasks yet.'}
            </li>
          ) : (
            inbox.map((record) => (
              <InboxRow
                key={record.task.id}
                record={record}
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

function ReviewRunSection({
  preset,
  onPresetChange,
  runs,
  selectedRun,
  invalidOutputs,
  onSelectRun,
  onValidateRun,
  onStartReview,
  onIngestRun,
  busy,
}: {
  preset: SwarmReviewPresetId
  onPresetChange: (next: SwarmReviewPresetId) => void
  runs: WatchtowerRun[]
  selectedRun: WatchtowerRun | null
  invalidOutputs: Extract<WatchtowerOutputValidationResult, { ok: true }>['invalid']
  onSelectRun: (runId: string) => void
  onValidateRun: () => void
  onStartReview: () => void
  onIngestRun: () => void
  busy: boolean
}) {
  const selectedPreset = SWARM_REVIEW_PRESETS.find((item) => item.id === preset) ?? SWARM_REVIEW_PRESETS[0]
  const presetAgents = Object.entries(selectedPreset.agents)
  return (
    <div className="border-b border-[#1f2025] bg-[#0b0c0f] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a92]">Review Run</div>
          <div className="mt-1 truncate text-[12px] text-[#c8c8cf]">{selectedPreset.description}</div>
        </div>
        <button
          type="button"
          onClick={onStartReview}
          disabled={busy || presetAgents.length === 0}
          className="h-7 shrink-0 rounded border border-[#3a2820] bg-[#241513] px-2.5 text-[11px] font-semibold text-[#ffe2d4] hover:bg-[#2c1a18] disabled:opacity-50"
        >
          Start
        </button>
      </div>
      <div className="mt-3 grid gap-2">
        <select
          value={preset}
          onChange={(event) => onPresetChange(event.target.value as SwarmReviewPresetId)}
          className="h-8 rounded border border-[#2a2b31] bg-[#0d0e11] px-2 text-[12px] text-[#ececee]"
        >
          {SWARM_REVIEW_PRESETS.filter((item) => item.id !== 'custom').map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        {presetAgents.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {presetAgents.map(([specialistId, sectors]) => {
              const specialist = getSpecialistAction(specialistId as SpecialistActionId)
              const labels = (sectors ?? []).map((sector) => getSwarmReviewSector(sector).label)
              return (
                <span key={specialistId} className="rounded border border-[#2a2b31] bg-[#111216] px-2 py-1 text-[11px] text-[#d7d7dc]">
                  {specialist.shortLabel}: {labels.join(', ')}
                </span>
              )
            })}
          </div>
        ) : null}
      </div>
      <div className="mt-3 border-t border-[#1f2025] pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6f7078]">Recent Runs</div>
          {selectedRun ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onValidateRun}
                disabled={busy}
                className="h-6 rounded border border-[#2a2b31] px-2 text-[11px] text-[#c8c8cf] hover:bg-[#111216] disabled:opacity-50"
              >
                Validate
              </button>
              <button
                type="button"
                onClick={onIngestRun}
                disabled={busy}
                className="h-6 rounded border border-[#2a2b31] px-2 text-[11px] text-[#c8c8cf] hover:bg-[#111216] disabled:opacity-50"
              >
                Ingest
              </button>
            </div>
          ) : null}
        </div>
        {runs.length === 0 ? (
          <div className="mt-2 text-[12px] text-[#6f7078]">No Watchtower runs yet.</div>
        ) : (
          <div className="mt-2 max-h-32 space-y-1 overflow-auto">
            {runs.slice(0, 6).map((run) => (
              <button
                type="button"
                key={run.runId}
                onClick={() => onSelectRun(run.runId)}
                className={`flex w-full min-w-0 items-center justify-between gap-2 rounded border px-2 py-1.5 text-left ${
                  selectedRun?.runId === run.runId
                    ? 'border-[#3a2820] bg-[#17110f]'
                    : 'border-[#202128] bg-[#0d0e11] hover:bg-[#111216]'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px] text-[#d7d7dc]">{run.runId}</span>
                  <span className="mt-0.5 block text-[11px] text-[#6f7078]">
                    {run.status} · valid {run.counts.valid} · invalid {run.counts.invalid} · ingested {run.counts.ingested}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-[#6f7078]">{run.agents.length}</span>
              </button>
            ))}
          </div>
        )}
        {invalidOutputs.length > 0 ? (
          <div className="mt-2 max-h-28 overflow-auto rounded border border-[#3a2222] bg-[#171010]">
            {invalidOutputs.slice(0, 4).map((output) => (
              <div key={`${output.path}:${output.line ?? 'file'}`} className="border-b border-[#2a1919] px-2 py-1.5 last:border-b-0">
                <div className="truncate font-mono text-[11px] text-[#ffb3b5]">
                  {output.path}{output.line ? `:${output.line}` : ''}
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-[#d6a0a2]">{output.error}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function InboxRow({
  record,
  selected,
  onSelect,
}: {
  record: SwitchboardTaskRecord
  selected: boolean
  onSelect: () => void
}) {
  const task = record.task
  const commentCount = task.comments.length
  const labels = task.labels.slice(0, 3)
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left ${ROW_DIVIDER} ${
          selected
            ? 'bg-[#17181d] text-[#ececee]'
            : 'hover:bg-[#111216] text-[#c8c8cf]'
        }`}
      >
        <span
          className={`shrink-0 font-mono text-[11px] ${selected ? 'text-[#ffd6c2]' : 'text-[#8a8a92]'}`}
          style={{ minWidth: 56 }}
        >
          {shortIdentifier(record)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{task.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-[#6f7078]">
            <span className={`shrink-0 ${priorityToneClass(task.priority)}`}>{priorityLabel(task.priority)}</span>
            <span className="shrink-0">·</span>
            <span className="truncate">{sourceLabel(record)}</span>
            {labels.length > 0 ? (
              <>
                <span className="shrink-0">·</span>
                <span className="truncate">{labels.join(', ')}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="ml-2 shrink-0 text-right">
          <span className="block text-[11px] text-[#6f7078]">{formatRelativeTime(task.createdAt)}</span>
          {commentCount > 0 ? (
            <span className="mt-0.5 block text-[11px] text-[#9a9aa2]">{commentCount} ◇</span>
          ) : null}
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
  commentBody: string
  onCommentChange: (next: string) => void
  onAddComment: () => void
  busy: boolean
}) {
  const task = record.task
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#1f2025] px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-[#6f7078]">
            <span className="font-mono text-[12px] text-[#ffd6c2]">{shortIdentifier(record)}</span>
            <span>·</span>
            <span>Inbox</span>
            <span>·</span>
            <span>{formatRelativeTime(task.createdAt)}</span>
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
                onClick={onPromote}
                disabled={busy}
                className="h-7 rounded border border-[#3a2820] bg-[#2c1a18] px-2.5 text-[11px] font-semibold text-[#ffe2d4] hover:bg-[#3a2421] disabled:opacity-50"
              >
                Promote to Board
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
              className="block w-48 rounded border border-[#2a2b31] bg-[#0d0e11] px-2 py-1 font-mono text-[12px] text-[#ececee]"
            />
          ) : (
            <span className="font-mono text-[12px] text-[#d7d7dc]">{task.identifier}</span>
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
            <span className={`text-[12px] ${priorityToneClass(task.priority)}`}>{priorityLabel(task.priority)}</span>
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
                <span>{formatRelativeTime(comment.createdAt)}</span>
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
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#ffe2d4]">New inbox task</h3>
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
            placeholder="Short triage title"
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
            placeholder="What did you observe? What should the next reader know?"
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
              placeholder="WT-7"
              className="mt-1 h-9 w-full rounded border border-[#2a2b31] bg-[#08090b] px-2 text-[13px] text-[#ececee]"
            />
          </label>
        </div>
        <label className="mt-3 block">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[#8a8a92]">Labels (comma separated)</span>
          <input
            value={draft.labels}
            onChange={(event) => onChange({ ...draft, labels: event.target.value })}
            placeholder="bug, auth"
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
            className="h-8 rounded border border-[#3a2820] bg-[#2c1a18] px-3 text-[12px] font-semibold text-[#ffe2d4] hover:bg-[#3a2421] disabled:opacity-50"
          >
            Create in inbox
          </button>
        </div>
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
    <div className={`pointer-events-none absolute bottom-3 right-3 rounded border px-3 py-1.5 text-[12px] ${cls}`}>
      {toast.message}
    </div>
  )
}
