import { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { SpecialistActionIcon } from '../AppIcons'
import {
  MULTILOOP_STATE_SYNC_EVENT,
  getMultiloopStateSyncSnapshot,
  type MultiloopStateSyncEventDetail,
} from '../workspace/MultiloopStateSynchronizer'
import {
  MULTILOOP_AGENT_SOULS,
  getMultiloopAgentSoul,
  loadMultiloopAgentSoul,
  type MultiloopAgentSoulRole,
} from '../../specialists/specialistActions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentState,
  MultiloopArtifact,
  MultiloopBlocker,
  MultiloopDecision,
  MultiloopMilestone,
  MultiloopMilestoneStatus,
  MultiloopState,
  MultiloopStateDisplayError,
  MultiloopTask,
  MultiloopTaskStatus,
  WorkspaceId,
} from '../../types/workspace'
import { prependAgentIdentifier } from '../../utils/agentPrompt'
import { focusOrAddAgentTab } from '../../utils/modelRegistry'
import {
  buildMultiloopLaunchContextLines,
  getActiveMultiloopBlockers,
  getActiveMultiloopMilestone,
  getLatestMultiloopEvidenceTasks,
  getMultiloopTasksForMilestone,
} from '../../utils/multiloop'
import { parseMultiloopStateFile } from '../../utils/multiloopStateFile'

type Props = {
  workspaceId: WorkspaceId
}

type ReadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: MultiloopStateDisplayError }
type RoleLaunchState =
  | { status: 'idle' }
  | { status: 'loading'; role: MultiloopAgentSoulRole }
  | { status: 'error'; role: MultiloopAgentSoulRole; message: string }

type TaskColumn = {
  key: MultiloopTaskStatus
  label: string
  hint: string
}

const taskColumns: TaskColumn[] = [
  { key: 'ready', label: 'Ready', hint: 'Can start' },
  { key: 'in_progress', label: 'In Progress', hint: 'Owned now' },
  { key: 'needs_input', label: 'Needs Input', hint: 'Waiting' },
  { key: 'blocked', label: 'Blocked', hint: 'Stopped' },
  { key: 'todo', label: 'Todo', hint: 'Queued' },
  { key: 'done', label: 'Done', hint: 'Accepted' },
]

const milestoneStatusLabels: Record<MultiloopMilestoneStatus, string> = {
  accepted: 'Accepted',
  active: 'Active',
  blocked: 'Blocked',
  planned: 'Planned',
}

const taskStatusLabels: Record<MultiloopTaskStatus, string> = {
  blocked: 'Blocked',
  done: 'Done',
  in_progress: 'In Progress',
  needs_input: 'Needs Input',
  ready: 'Ready',
  todo: 'Todo',
}

const milestoneStatusClass: Record<MultiloopMilestoneStatus, string> = {
  accepted: 'border-[#2f5f3f] bg-[#112318] text-[#bff7ce]',
  active: 'border-[#355da8] bg-[#111b30] text-[#b8ccff]',
  blocked: 'border-[#755337] bg-[#271a10] text-[#ffd39a]',
  planned: 'border-[#32343b] bg-[#101116] text-[#b6b7bf]',
}

const taskStatusClass: Record<MultiloopTaskStatus, string> = {
  blocked: 'bg-[#3a2415] text-[#ffd39a]',
  done: 'bg-[#14321f] text-[#c8f7d2]',
  in_progress: 'bg-[#172342] text-[#c5d4ff]',
  needs_input: 'bg-[#3a3115] text-[#ffe19b]',
  ready: 'bg-[#163021] text-[#c6f5d2]',
  todo: 'bg-[#191a20] text-[#b6b7bf]',
}

function hasEvidence(task: MultiloopTask): boolean {
  return Boolean(
    task.evidence.summary.trim()
    || task.evidence.touchedFiles.length
    || task.evidence.commandsRan.length
    || task.evidence.results.length
  )
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function formatDate(value: string | null): string {
  if (!value) return 'No timestamp'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function getNextRecommendation(milestone: MultiloopMilestone | null): string {
  const verdicts = milestone?.reviewVerdicts ?? []
  const latestVerdict = verdicts[verdicts.length - 1]
  return latestVerdict?.nextRecommendation || 'Continue the active milestone until acceptance evidence is complete.'
}

function formatMultiloopGoal(goal: string): string {
  const trimmed = goal.trim()
  return trimmed || 'No final goal recorded.'
}

function formatMultiloopGoalPreview(goal: string): string {
  const formatted = formatMultiloopGoal(goal)
  if (formatted === 'No final goal recorded.') return formatted

  const firstLine = goal
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) return formatted

  const firstSentence = firstLine.match(/^(.+?[.!?])(?:\s|$)/u)?.[1]?.trim()
  return firstSentence || firstLine
}

function getRelatedArtifacts(artifacts: MultiloopArtifact[], milestoneId: string | null, tasks: MultiloopTask[]): MultiloopArtifact[] {
  if (!milestoneId) return []
  const taskIds = new Set(tasks.map((task) => task.id))
  return artifacts.filter((artifact) => artifact.milestoneId === milestoneId || (artifact.taskId !== null && taskIds.has(artifact.taskId)))
}

function toProjectRelativePath(path: string | null | undefined, workspaceRoot: string | null | undefined): string {
  if (!path) return 'multiloop/<loop>/state.json'

  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = workspaceRoot?.replace(/\\/g, '/').replace(/\/+$/u, '')
  if (normalizedRoot && (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`))) {
    return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/u, '') || '.'
  }

  const multiloopIndex = normalizedPath.lastIndexOf('/multiloop/')
  if (multiloopIndex >= 0) return normalizedPath.slice(multiloopIndex + 1)
  return 'multiloop/<loop>/state.json'
}

function buildMultiloopStartupPrompt({
  soulPrompt,
  role,
  state,
  statePath,
  workspaceRoot,
}: {
  soulPrompt: string
  role: MultiloopAgentSoulRole
  state: MultiloopState
  statePath: string | null
  workspaceRoot: string | null
}): string {
  const soul = getMultiloopAgentSoul(role)
  const currentMilestone = getActiveMultiloopMilestone(state)
  const stateRelativePath = toProjectRelativePath(statePath, workspaceRoot)
  const context = buildMultiloopLaunchContextLines({
    roleLabel: soul.label,
    loopName: state.loop.displayName,
    finalGoal: state.loop.finalGoal,
    currentMilestone,
    statePath: stateRelativePath,
  })

  return [soulPrompt.trim(), ...context].join('\n')
}

function isMultiloopStateSyncEventDetail(input: unknown): input is MultiloopStateSyncEventDetail {
  if (!input || typeof input !== 'object') return false
  const detail = input as Partial<MultiloopStateSyncEventDetail>
  return typeof detail.workspaceId === 'string'
    && typeof detail.statePath === 'string'
    && (detail.status === 'ok' || detail.status === 'error')
}

export default function MultiloopBoardPanel({ workspaceId }: Props) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === workspaceId))
  const setMultiloopState = useWorkspaceStore((state) => state.setMultiloopState)
  const updateAgent = useWorkspaceStore((state) => state.updateAgent)
  const [readState, setReadState] = useState<ReadState>({ status: 'idle' })
  const [roleLaunchState, setRoleLaunchState] = useState<RoleLaunchState>({ status: 'idle' })
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [goalExpanded, setGoalExpanded] = useState(false)

  const multiloopState = workspace?.multiloopState ?? null
  const statePath = workspace?.multiloopContext?.statePath ?? null
  const workspaceRoot = workspace?.folderPath ?? null

  useEffect(() => {
    const snapshot = getMultiloopStateSyncSnapshot(workspaceId)
    if (snapshot) {
      setReadState(snapshot.status === 'ok'
        ? { status: 'idle' }
        : { status: 'error', error: snapshot.error })
    }

    const handleStateSync = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isMultiloopStateSyncEventDetail(event.detail)) return
      if (event.detail.workspaceId !== workspaceId) return
      setReadState(event.detail.status === 'ok'
        ? { status: 'idle' }
        : { status: 'error', error: event.detail.error })
    }

    window.addEventListener(MULTILOOP_STATE_SYNC_EVENT, handleStateSync)
    return () => window.removeEventListener(MULTILOOP_STATE_SYNC_EVENT, handleStateSync)
  }, [workspaceId])

  const openRoleAgent = async (role: MultiloopAgentSoulRole) => {
    if (!workspace || !multiloopState) return

    const soul = getMultiloopAgentSoul(role)
    const agentId = `multiloop-${role}`
    const existingAgent = workspace.agents[agentId]
    if (existingAgent) {
      focusOrAddAgentTab(workspaceId, agentId, existingAgent.name || soul.label)
      return
    }

    setRoleLaunchState({ status: 'loading', role })
    try {
      const soulPrompt = await loadMultiloopAgentSoul(role)
      const startupPrompt = buildMultiloopStartupPrompt({
        soulPrompt,
        role,
        state: multiloopState,
        statePath,
        workspaceRoot,
      })
      const tabName = soul.label
      updateAgent(workspaceId, agentId, {
        name: tabName,
        cli: 'codex',
        cliPermissionPreset: 'default',
        kind: 'general',
        specialistId: undefined,
        cliStartupPrompt: prependAgentIdentifier(startupPrompt, tabName, `Multiloop ${soul.shortLabel}`),
        cliOnboardingPromptSent: false,
        cliHasLaunched: false,
        cliSessionId: `multiloop-${role}-${nanoid(6)}`,
      })
      focusOrAddAgentTab(workspaceId, agentId, tabName)
      setRoleLaunchState({ status: 'idle' })
    } catch (error) {
      setRoleLaunchState({
        status: 'error',
        role,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  useEffect(() => {
    if (multiloopState || !statePath) return

    let cancelled = false
    setReadState({ status: 'loading' })
    void window.api.readfile(statePath)
      .then((content) => {
        if (cancelled) return
        const parsed = parseMultiloopStateFile(content)
        if (parsed.ok) {
          setMultiloopState(workspaceId, parsed.state)
          setReadState({ status: 'idle' })
        } else {
          setReadState({ status: 'error', error: parsed.error })
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setReadState({
          status: 'error',
          error: {
            title: 'Missing Multiloop state',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })

    return () => {
      cancelled = true
    }
  }, [multiloopState, setMultiloopState, statePath, workspaceId])

  const activeMilestone = useMemo(
    () => (multiloopState ? getActiveMultiloopMilestone(multiloopState) : null),
    [multiloopState]
  )

  useEffect(() => {
    if (!multiloopState) return
    setSelectedMilestoneId((current) => {
      if (current && multiloopState.roadmap.some((milestone) => milestone.id === current)) return current
      return activeMilestone?.id ?? multiloopState.roadmap[0]?.id ?? null
    })
  }, [activeMilestone?.id, multiloopState])

  const selectedMilestone = useMemo(
    () => multiloopState?.roadmap.find((milestone) => milestone.id === selectedMilestoneId) ?? activeMilestone,
    [activeMilestone, multiloopState?.roadmap, selectedMilestoneId]
  )

  const visibleTasks = useMemo(
    () => (multiloopState && selectedMilestone ? getMultiloopTasksForMilestone(multiloopState, selectedMilestone.id) : []),
    [multiloopState, selectedMilestone]
  )
  const activeTasks = useMemo(
    () => (multiloopState && activeMilestone ? getMultiloopTasksForMilestone(multiloopState, activeMilestone.id) : []),
    [activeMilestone, multiloopState]
  )
  const activeBlockers = useMemo(
    () => (multiloopState ? getActiveMultiloopBlockers(multiloopState, activeMilestone?.id) : []),
    [activeMilestone?.id, multiloopState]
  )
  const latestEvidenceTasks = useMemo(
    () => (multiloopState ? getLatestMultiloopEvidenceTasks(multiloopState, 4) : []),
    [multiloopState]
  )
  const selectedTask = useMemo(
    () => visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks.find((task) => task.status !== 'done') ?? visibleTasks[0] ?? null,
    [selectedTaskId, visibleTasks]
  )
  const relatedArtifacts = useMemo(
    () => getRelatedArtifacts(multiloopState?.artifacts ?? [], selectedMilestone?.id ?? null, visibleTasks),
    [multiloopState?.artifacts, selectedMilestone?.id, visibleTasks]
  )
  const fullGoal = formatMultiloopGoal(multiloopState?.loop.finalGoal ?? '')
  const goalPreview = formatMultiloopGoalPreview(multiloopState?.loop.finalGoal ?? '')
  const canExpandGoal = fullGoal !== goalPreview || fullGoal.length > 260

  if (!workspace) return null
  if (readState.status === 'loading') return <StateMessage title="Loading Multiloop state" message="Reading the loop state file." tone="loading" />
  if (readState.status === 'error') {
    return (
      <StateMessage
        title={readState.error.title}
        message={readState.error.path ? `${readState.error.path}: ${readState.error.message}` : readState.error.message}
        tone="error"
      />
    )
  }
  if (!multiloopState) {
    return (
      <StateMessage
        title="No Multiloop state loaded"
        message={statePath ? 'The workspace has a state path, but no readable state is available yet.' : 'Open or create a Multiloop workspace with a state.json file.'}
        tone="empty"
      />
    )
  }
  if (multiloopState.roadmap.length === 0) {
    return (
      <StateMessage
        title="Empty roadmap"
        message="This loop has no milestones to display."
        tone="empty"
      />
    )
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#08090b] text-[#ececee] [overflow-wrap:anywhere]" aria-label="Multiloop milestone board">
      <header className="shrink-0 border-b border-[#202127] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#81828c]">Multiloop</p>
            <h1 className="mt-1 text-[20px] font-semibold leading-7 text-[#f5f5f6]">{multiloopState.loop.displayName}</h1>
            <button
              type="button"
              disabled={!canExpandGoal}
              onClick={() => {
                if (canExpandGoal) setGoalExpanded((current) => !current)
              }}
              aria-expanded={canExpandGoal ? goalExpanded : undefined}
              className={`mt-3 block w-full max-w-4xl rounded-[6px] border border-[#24252c] bg-[#0d0e12] px-3 py-2.5 text-left ${
                canExpandGoal ? 'transition hover:border-[#3a3c45] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]' : 'cursor-default'
              }`}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777882]">Final goal</span>
                {canExpandGoal ? (
                  <span className="shrink-0 text-[11px] font-medium text-[#9fb4ff]">
                    {goalExpanded ? 'Collapse' : 'Expand'}
                  </span>
                ) : null}
              </span>
              <span className={`mt-1 block whitespace-pre-wrap text-sm leading-6 text-[#b7b8bf] ${
                goalExpanded ? 'max-h-72 overflow-y-auto pr-2' : 'line-clamp-3'
              }`}>
                {goalExpanded ? fullGoal : goalPreview}
              </span>
            </button>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-2 text-right sm:grid-cols-4">
            <Meta label="Loop" value={multiloopState.loop.status} />
            <Meta label="Iteration" value={String(multiloopState.loop.iteration)} />
            <Meta label="Active blockers" value={String(activeBlockers.length)} tone={activeBlockers.length ? 'warn' : 'normal'} />
            <Meta label="Active tasks" value={`${activeTasks.filter((task) => task.status === 'done').length}/${activeTasks.length}`} />
          </div>
        </div>
        <MultiloopRoleLauncher
          agents={workspace.agents}
          launchState={roleLaunchState}
          onOpenRole={(role) => void openRoleAgent(role)}
        />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-b border-[#202127] p-4 lg:border-b-0 lg:border-r" aria-label="Roadmap milestones">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-semibold text-[#f0f0f2]">Roadmap</h2>
            <span className="text-[11px] text-[#898a93]">{formatCount(multiloopState.roadmap.length, 'milestone')}</span>
          </div>
          <div className="space-y-2">
            {multiloopState.roadmap.map((milestone, index) => {
              const isSelected = milestone.id === selectedMilestone?.id
              const isActive = milestone.id === activeMilestone?.id
              return (
                <button
                  key={milestone.id}
                  type="button"
                  className={`w-full rounded-[6px] border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${isSelected ? 'border-[#5c7cff] bg-[#12192b]' : 'border-[#25262d] bg-[#0d0e12] hover:border-[#3a3c45]'}`}
                  aria-pressed={isSelected}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => {
                    setSelectedMilestoneId(milestone.id)
                    setSelectedTaskId(null)
                  }}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block text-[11px] text-[#858690]">M{index + 1}</span>
                      <span className="mt-1 block text-sm font-medium leading-5 text-[#ededf0]">{milestone.title}</span>
                    </span>
                    <StatusPill label={milestoneStatusLabels[milestone.status]} className={milestoneStatusClass[milestone.status]} />
                  </span>
                  {isActive ? <span className="mt-2 block text-[11px] font-medium text-[#9fb4ff]">Current milestone</span> : null}
                </button>
              )
            })}
          </div>
        </aside>

        <main className="min-h-0 min-w-0 overflow-y-auto">
          <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="min-w-0 space-y-4">
              <MilestoneSummary milestone={selectedMilestone} activeMilestoneId={activeMilestone?.id ?? null} />
              <TopLevelSignals milestone={activeMilestone} blockers={activeBlockers} />
              <TaskBoard tasks={visibleTasks} selectedTaskId={selectedTask?.id ?? null} onSelectTask={setSelectedTaskId} />
            </div>

            <aside className="min-w-0 space-y-4" aria-label="Milestone details">
              <TaskDetail task={selectedTask} />
              <EvidencePanel tasks={latestEvidenceTasks} />
              <FactsPanel milestone={selectedMilestone} decisions={multiloopState.decisions} />
              <ArtifactsPanel artifacts={relatedArtifacts} />
            </aside>
          </div>
        </main>
      </div>
    </section>
  )
}

function MultiloopRoleLauncher({
  agents,
  launchState,
  onOpenRole,
}: {
  agents: Record<string, AgentState>
  launchState: RoleLaunchState
  onOpenRole: (role: MultiloopAgentSoulRole) => void
}) {
  return (
    <div className="mt-4 border-t border-[#202127] pt-3" aria-label="Multiloop role terminals">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold text-[#f0f0f2]">Role Terminals</h2>
        {launchState.status === 'error' ? (
          <span className="text-[11px] text-[#ffb5b8]">{getMultiloopAgentSoul(launchState.role).label}: {launchState.message}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {MULTILOOP_AGENT_SOULS.map((soul) => {
          const agentId = `multiloop-${soul.role}`
          const exists = Boolean(agents[agentId])
          const loading = launchState.status === 'loading' && launchState.role === soul.role
          return (
            <button
              key={soul.role}
              type="button"
              onClick={() => onOpenRole(soul.role)}
              disabled={loading}
              className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-[#303139] bg-[#111216] px-2.5 text-[12px] font-semibold text-[#d7d7dc] transition hover:border-[#444751] hover:bg-[#17181d] hover:text-[#ececee] disabled:cursor-default disabled:opacity-60"
              title={`${exists ? 'Focus' : 'Create'} ${soul.label} role terminal`}
            >
              <SpecialistActionIcon icon={soul.icon} className="h-4 w-4 shrink-0 text-[#9a9aa2]" />
              <span>{loading ? 'Opening...' : soul.label}</span>
              {exists ? <span className="h-1.5 w-1.5 rounded-full bg-[#6ee7d8]" aria-label="Created" /> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function StateMessage({ title, message, tone }: { title: string; message: string; tone: 'empty' | 'error' | 'loading' }) {
  const toneClass = tone === 'error' ? 'border-[#6f3131] text-[#ffb5b8]' : 'border-[#25262d] text-[#b9bac2]'
  return (
    <section className="flex h-full min-w-0 items-center justify-center bg-[#08090b] px-6 text-center text-[#ececee] [overflow-wrap:anywhere]" role={tone === 'loading' ? 'status' : 'region'} aria-live="polite">
      <div className={`min-w-0 max-w-md rounded-[8px] border ${toneClass} bg-[#0d0e12] p-5`}>
        <h1 className="text-base font-semibold text-[#f2f2f4]">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-[#a9aab2]">{message}</p>
      </div>
    </section>
  )
}

function Meta({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'warn' }) {
  return (
    <div className="min-w-[5.5rem] rounded-[6px] bg-[#101116] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#777882]">{label}</div>
      <div className={`mt-1 text-sm font-semibold capitalize ${tone === 'warn' ? 'text-[#ffd39a]' : 'text-[#ececee]'}`}>{value.replace(/_/g, ' ')}</div>
    </div>
  )
}

function StatusPill({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-[999px] border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${className}`}>
      {label}
    </span>
  )
}

function MilestoneSummary({ milestone, activeMilestoneId }: { milestone: MultiloopMilestone | null; activeMilestoneId: string | null }) {
  if (!milestone) {
    return <PanelSection title="Milestone" empty="No milestone selected." />
  }

  const isActive = milestone.id === activeMilestoneId
  return (
    <section className="rounded-[8px] border border-[#24252c] bg-[#0d0e12] p-4" aria-label="Selected milestone">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={milestoneStatusLabels[milestone.status]} className={milestoneStatusClass[milestone.status]} />
            {isActive ? <span className="text-[11px] font-medium text-[#9fb4ff]">Default active board</span> : <span className="text-[11px] text-[#858690]">Historical view</span>}
          </div>
          <h2 className="mt-2 text-lg font-semibold leading-7 text-[#f4f4f5]">{milestone.title}</h2>
          <p className="mt-1 text-sm leading-6 text-[#b8b9c1]">{milestone.goal || 'No milestone goal recorded.'}</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ListBlock title="Entry criteria" items={milestone.entryCriteria} />
        <ListBlock title="Acceptance criteria" items={milestone.acceptanceCriteria} />
      </div>
      <div className="mt-4 rounded-[6px] bg-[#101116] p-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777882]">Final goal contribution</div>
        <p className="mt-1 text-sm leading-6 text-[#c7c8cf]">{milestone.finalGoalContribution || 'No contribution recorded.'}</p>
      </div>
    </section>
  )
}

function TopLevelSignals({ milestone, blockers }: { milestone: MultiloopMilestone | null; blockers: MultiloopBlocker[] }) {
  const verdicts = milestone?.reviewVerdicts ?? []
  return (
    <section className="grid gap-4 md:grid-cols-2" aria-label="Active blockers and verdicts">
      <PanelSection title={`Active blockers (${blockers.length})`} empty="No active blockers in the current milestone.">
        {blockers.map((blocker) => (
          <div key={blocker.id} className="rounded-[6px] bg-[#15120f] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-[#ffd39a]">{blocker.summary}</span>
              <span className="shrink-0 text-[11px] uppercase tracking-[0.1em] text-[#b99568]">{blocker.scope}</span>
            </div>
            {blocker.detail ? <p className="mt-1 text-sm leading-5 text-[#d7c2a4]">{blocker.detail}</p> : null}
          </div>
        ))}
      </PanelSection>
      <PanelSection title={`Review verdicts (${verdicts.length})`} empty="No review verdicts recorded for the active milestone.">
        {verdicts.slice(-3).reverse().map((verdict) => (
          <div key={verdict.id} className="rounded-[6px] bg-[#101116] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold capitalize text-[#ececee]">{verdict.verdict.replace(/_/g, ' ')}</span>
              <span className="text-[11px] text-[#8d8e97]">{verdict.role}</span>
            </div>
            <p className="mt-1 text-sm leading-5 text-[#bfc0c8]">{verdict.nextRecommendation}</p>
          </div>
        ))}
      </PanelSection>
      <div className="rounded-[8px] border border-[#24252c] bg-[#0d0e12] p-4 md:col-span-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777882]">Next recommendation</div>
        <p className="mt-1 text-sm leading-6 text-[#d7d8de]">{getNextRecommendation(milestone)}</p>
      </div>
    </section>
  )
}

function TaskBoard({ tasks, selectedTaskId, onSelectTask }: { tasks: MultiloopTask[]; selectedTaskId: string | null; onSelectTask: (taskId: string) => void }) {
  if (tasks.length === 0) {
    return <PanelSection title="Active milestone tasks" empty="This milestone has no tasks." />
  }

  return (
    <section className="rounded-[8px] border border-[#24252c] bg-[#0d0e12] p-4" aria-label="Milestone task board">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-[#f0f0f2]">Milestone Tasks</h2>
        <span className="text-[11px] text-[#898a93]">{formatCount(tasks.length, 'task')}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {taskColumns.map((column) => {
          const columnTasks = tasks.filter((task) => task.status === column.key)
          return (
            <div key={column.key} className="min-h-[9rem] rounded-[6px] bg-[#101116] p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[#ececee]">{column.label}</h3>
                  <p className="text-[11px] text-[#777882]">{column.hint}</p>
                </div>
                <span className="text-[11px] font-semibold text-[#9a9ba4]">{columnTasks.length}</span>
              </div>
              <div className="space-y-2">
                {columnTasks.length === 0 ? <p className="text-xs text-[#686972]">No tasks</p> : columnTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className={`w-full rounded-[6px] border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${selectedTaskId === task.id ? 'border-[#5c7cff] bg-[#151d32]' : 'border-[#292a31] bg-[#0b0c10] hover:border-[#3d3f48]'}`}
                    aria-pressed={selectedTaskId === task.id}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-sm font-medium leading-5 text-[#e7e7ea]">{task.title}</span>
                      <span className="shrink-0 text-[11px] text-[#858690]">{task.id}</span>
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[#8e8f98]">
                      <span>{task.role}</span>
                      {task.ownerAgentId ? <span>{task.ownerAgentId}</span> : null}
                      {hasEvidence(task) ? <span className="text-[#b7d0ff]">Evidence</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function TaskDetail({ task }: { task: MultiloopTask | null }) {
  if (!task) return <PanelSection title="Task detail" empty="Select a task to inspect details." />
  return (
    <PanelSection title="Task detail">
      <div className="space-y-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={taskStatusLabels[task.status]} className={`border-transparent ${taskStatusClass[task.status]}`} />
            <span className="text-[11px] text-[#858690]">{task.id}</span>
          </div>
          <h3 className="mt-2 text-sm font-semibold leading-5 text-[#ededf0]">{task.title}</h3>
          {task.description ? <p className="mt-1 text-sm leading-5 text-[#b9bac2]">{task.description}</p> : null}
        </div>
        <ListBlock title="Acceptance" items={task.acceptanceCriteria} />
        <ListBlock title="Blockers" items={task.blockers} />
      </div>
    </PanelSection>
  )
}

function EvidencePanel({ tasks }: { tasks: MultiloopTask[] }) {
  return (
    <PanelSection title="Latest evidence" empty="No task evidence recorded yet.">
      {tasks.map((task) => (
        <div key={task.id} className="rounded-[6px] bg-[#101116] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-[#ececee]">{task.id}</span>
            <span className="text-[11px] text-[#858690]">{formatDate(task.updatedAt ?? task.completedAt ?? task.startedAt ?? task.createdAt)}</span>
          </div>
          <p className="mt-1 text-sm leading-5 text-[#bfc0c8]">{task.evidence.summary || task.title}</p>
          {task.evidence.results.length ? <p className="mt-1 text-xs text-[#9daedc]">{task.evidence.results[0]}</p> : null}
        </div>
      ))}
    </PanelSection>
  )
}

function FactsPanel({ milestone, decisions }: { milestone: MultiloopMilestone | null; decisions: MultiloopDecision[] }) {
  const learnedFacts = milestone?.learnedFacts ?? []
  const visibleDecisions = decisions.slice(-3).reverse()
  const hasContent = learnedFacts.length > 0 || visibleDecisions.length > 0

  if (!hasContent) {
    return <PanelSection title="Learned facts and decisions" empty="No learned facts or decisions recorded yet." />
  }

  return (
    <PanelSection title="Learned facts and decisions">
      {learnedFacts.map((fact) => (
        <p key={fact} className="rounded-[6px] bg-[#101116] p-3 text-sm leading-5 text-[#c7c8cf]">{fact}</p>
      ))}
      {visibleDecisions.map((decision) => (
        <div key={decision.id} className="rounded-[6px] bg-[#101116] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#858690]">Decision</span>
            <span className="text-[11px] text-[#858690]">{decision.createdBy ?? 'unknown'}</span>
          </div>
          <p className="mt-1 text-sm leading-5 text-[#c7c8cf]">{decision.summary || 'Decision recorded without summary.'}</p>
        </div>
      ))}
    </PanelSection>
  )
}

function ArtifactsPanel({ artifacts }: { artifacts: MultiloopArtifact[] }) {
  return (
    <PanelSection title="Artifacts" empty="No artifacts are linked to this milestone.">
      {artifacts.map((artifact) => (
        <div key={artifact.id} className="rounded-[6px] bg-[#101116] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-[#ececee]">{artifact.title}</span>
            <span className="text-[11px] text-[#858690]">{artifact.kind || 'artifact'}</span>
          </div>
          {artifact.path ? <p className="mt-1 break-all font-mono text-[11px] text-[#8f9cc0]">{artifact.path}</p> : null}
        </div>
      ))}
    </PanelSection>
  )
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777882]">{title}</div>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-[#858690]">None recorded.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li key={item} className="text-sm leading-5 text-[#c7c8cf]">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PanelSection({ title, empty, children }: { title: string; empty?: string; children?: React.ReactNode }) {
  const hasChildren = Boolean(children)
  return (
    <section className="rounded-[8px] border border-[#24252c] bg-[#0d0e12] p-4">
      <h2 className="text-[13px] font-semibold text-[#f0f0f2]">{title}</h2>
      {hasChildren ? <div className="mt-3 space-y-2">{children}</div> : <p className="mt-3 text-sm leading-6 text-[#8e8f98]">{empty}</p>}
    </section>
  )
}
