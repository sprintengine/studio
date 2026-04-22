import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  SwarmRole,
  SwarmState,
  SwarmTask,
  SwarmTaskBoardColumn,
  SwarmTaskStatus,
} from '../../types/workspace'
import CliIcon from '../CliIcon'
import {
  buildSwarmAgentRosterForState,
  getSwarmTaskBoardColumn,
  swarmRoleAccent,
  swarmRoleLabels,
} from '../../utils/swarm'
import { renderMarkdown } from '../../utils/markdown'
import {
  getSwarmDirectoryPath,
  getSwarmPlanFilePath,
  getSwarmRootDirectoryPath,
  getSwarmStateFilePath,
  parseSwarmStateFile,
  serializeSwarmStateFile,
  slugifySwarmName,
} from '../../utils/swarmStateFile'
import { focusOrAddAgentTab, focusOrAddComponentTab } from '../../utils/modelRegistry'

const columnMeta: { key: SwarmTaskBoardColumn; label: string; tint: string }[] = [
  { key: 'todo', label: 'Todo', tint: 'bg-[#111216] text-[#9a9aa2]' },
  { key: 'ready', label: 'Ready', tint: 'bg-[#30d158]/15 text-[#b9f7c8]' },
  { key: 'in_progress', label: 'In Progress', tint: 'bg-[#ffa600]/18 text-[#ffd58a]' },
  { key: 'needs_input', label: 'Needs Input', tint: 'bg-[#ffbf2f]/20 text-[#ffe0a3]' },
  { key: 'done', label: 'Done', tint: 'bg-[#30d158]/12 text-[#d4ffdc]' },
]

const taskStateLabel: Record<SwarmTaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  needs_input: 'Needs Input',
  done: 'Done',
}

const addableRoles: SwarmRole[] = ['product', 'frontend', 'developer', 'tester', 'security']
const cliOptions: Array<{ value: AgentCli; label: string; description: string }> = [
  { value: 'codex', label: 'Codex', description: 'OpenAI Codex CLI' },
  { value: 'claude', label: 'Claude', description: 'Claude Code CLI' },
]

const roleSummaries: Record<SwarmRole, string> = {
  architect: 'Plans the run and gates readiness.',
  product: 'Shapes scope, positioning, audience fit, and priority tradeoffs.',
  developer: 'Builds implementation and integration work.',
  frontend: 'Owns interaction design, visual quality, and UI implementation.',
  tester: 'Validates behavior, regressions, and acceptance criteria.',
  security: 'Reviews trust boundaries, command safety, data handling, and hardening.',
}

interface Props {
  workspaceId: string
  fixedView?: SwarmView
}

type SyncState = {
  status: 'idle' | 'syncing' | 'live' | 'error'
  message: string
}


type PlanReviewState = {
  open: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  content: string
  error: string | null
  mode: 'preview' | 'source'
}

type SwarmView = 'map' | 'kanban'

type SpawnDialogState = {
  agentId: string
  cli: AgentCli
}

type RecoveryDialogState = {
  cli: AgentCli
}

export default function SwarmBoardPanel({ workspaceId, fixedView }: Props) {
  const workspace = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null
  )
  const setSwarmState = useWorkspaceStore((s) => s.setSwarmState)
  const addSwarmMember = useWorkspaceStore((s) => s.addSwarmMember)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<SwarmView>('map')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [spawnDialog, setSpawnDialog] = useState<SpawnDialogState | null>(null)
  const [recoveryDialog, setRecoveryDialog] = useState<RecoveryDialogState | null>(null)
  const [cliPickerOpen, setCliPickerOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addMemberRole, setAddMemberRole] = useState<SwarmRole>('developer')
  const [showRunSummary, setShowRunSummary] = useState(false)
  const [goalExpanded, setGoalExpanded] = useState(false)
  const [planReview, setPlanReview] = useState<PlanReviewState>({
    open: false,
    status: 'idle',
    content: '',
    error: null,
    mode: 'preview',
  })
  const [, setSyncState] = useState<SyncState>({
    status: 'idle',
    message: 'Waiting for a swarm workspace folder.',
  })
  const lastSyncedContentRef = useRef<string | null>(null)
  const initialReadDoneRef = useRef(false)

  const swarmState = workspace?.swarmState ?? null
  const effectiveView = fixedView ?? activeView
  const folderPath = workspace?.folderPath ?? null
  const agents = workspace?.agents ?? {}
  const swarmName = swarmState?.name ?? workspace?.name ?? 'Swarm Team'

  useEffect(() => {
    setGoalExpanded(false)
  }, [swarmState?.goal])

  const roster = useMemo(
    () => buildSwarmAgentRosterForState(swarmState),
    [swarmState]
  )

  const rosterById = useMemo(
    () => Object.fromEntries(roster.map((agent) => [agent.id, agent])),
    [roster]
  )

  const serializedState = useMemo(() => {
    if (!swarmState || !folderPath || !workspace) return null
    return serializeSwarmStateFile({
      workspaceId,
      workspacePath: folderPath,
      swarmState,
    })
  }, [folderPath, swarmState, workspace, workspaceId])

  useEffect(() => {
    if (!swarmState || !folderPath || !serializedState) {
      setSyncState({
        status: 'idle',
        message: 'Choose a workspace folder to enable shared swarm state.',
      })
      return
    }

    let cancelled = false

    const writeStateFile = async () => {
      try {
        const swarmRootDirectory = getSwarmRootDirectoryPath(folderPath)
        const swarmDirectory = getSwarmDirectoryPath(folderPath, swarmName)
        const stateFilePath = getSwarmStateFilePath(folderPath, swarmName)
        setSyncState({ status: 'syncing', message: 'Writing swarm state to disk...' })

        // On first mount, read the existing state file before writing so we
        // don't clobber an in-progress swarm with a fresh Zustand state.
        if (!initialReadDoneRef.current) {
          initialReadDoneRef.current = true
          try {
            const existing = await window.api.readfile(stateFilePath)
            if (cancelled) return
            const parsed = parseSwarmStateFile(existing)
            lastSyncedContentRef.current = existing
            setSwarmState(workspaceId, parsed)
            return // re-render will re-run this effect with the correct state
          } catch { /* file doesn't exist yet — proceed to write */ }
        }

        await window.api.ensureDir(folderPath, 'swarm')
        await window.api.ensureDir(swarmRootDirectory, slugifySwarmName(swarmName))

        if (cancelled) return
        if (lastSyncedContentRef.current === serializedState) {
          setSyncState({ status: 'live', message: `Shared state live at ${stateFilePath}` })
          return
        }

        await window.api.writefile(stateFilePath, serializedState)
        if (cancelled) return
        lastSyncedContentRef.current = serializedState
        setSyncState({ status: 'live', message: `Shared state live at ${swarmDirectory}` })
      } catch (error) {
        if (cancelled) return
        setSyncState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to write swarm state.',
        })
      }
    }

    void writeStateFile()

    return () => {
      cancelled = true
    }
  }, [folderPath, serializedState, swarmName, swarmState, workspaceId])

  useEffect(() => {
    if (!swarmState || !folderPath) return

    let disposed = false
    let stopWatching: (() => Promise<void>) | null = null
    const swarmDirectory = getSwarmDirectoryPath(folderPath, swarmName)
    const stateFilePath = getSwarmStateFilePath(folderPath, swarmName)
    let debounce: number | null = null

    const readExternalState = async () => {
      try {
        const content = await window.api.readfile(stateFilePath)
        if (disposed || content === lastSyncedContentRef.current) return
        const parsed = parseSwarmStateFile(content)
        lastSyncedContentRef.current = content
        setSwarmState(workspaceId, parsed)
      } catch { /* file not yet written */ }
    }

    const startWatching = async () => {
      try {
        stopWatching = await window.api.watchPath(swarmDirectory, (event) => {
          if (event.path && !event.path.endsWith('state.yaml')) return
          if (debounce !== null) window.clearTimeout(debounce)
          debounce = window.setTimeout(() => { void readExternalState() }, 120)
        })
      } catch { /* directory may not exist yet */ }
    }

    void startWatching()

    return () => {
      disposed = true
      if (debounce !== null) window.clearTimeout(debounce)
      if (stopWatching) void stopWatching()
    }
  }, [folderPath, setSwarmState, swarmName, swarmState, workspaceId])

  const runtimeAgents = useMemo(
    () => roster.map((agent) => ({
      agentId: agent.id,
      role: swarmState?.swarmAgents[agent.id]?.role ?? agent.role,
      status: swarmState?.swarmAgents[agent.id]?.status ?? 'idle',
      currentTaskId: swarmState?.swarmAgents[agent.id]?.currentTaskId ?? null,
    })),
    [roster, swarmState?.swarmAgents]
  )

  const boardColumns = useMemo(() => {
    if (!swarmState) return []

    return columnMeta.map((column) => ({
      ...column,
      cards: swarmState.tasks.filter(
        (task) => getSwarmTaskBoardColumn(task, swarmState.tasks) === column.key
      ),
    }))
  }, [swarmState])

  const selectedTask = swarmState?.tasks.find((task) => task.id === selectedTaskId) ?? null

  if (!swarmState) {
    return (
      <div className="flex h-full items-center justify-center bg-[#08090b] text-sm text-[#5a5a63]">
        Swarm workspace data is missing.
      </div>
    )
  }

  const doneCount = swarmState.tasks.filter((task) => task.status === 'done').length
  const activeCount = runtimeAgents.filter((agent) => agent.status === 'running').length
  const needsInputCount = runtimeAgents.filter((agent) => agent.status === 'needs_input').length
  const runPhase = getRunPhase(swarmState, runtimeAgents)
  const allTasksDone = swarmState.tasks.length > 0 && doneCount === swarmState.tasks.length
  const runSummary = buildRunSummary(swarmState.tasks)
  const architectAgentId = roster.find((agent) => agent.role === 'architect')?.id ?? null
  const planFilePath = folderPath ? getSwarmPlanFilePath(folderPath, swarmName) : null
  const resolvedSelectedAgentId = selectedAgentId ?? architectAgentId ?? roster[0]?.id ?? null
  const workerRoles: SwarmRole[] = ['developer', 'frontend', 'product', 'tester', 'security']
  const readyTasks = swarmState.tasks.filter(
    (task) => getSwarmTaskBoardColumn(task, swarmState.tasks) === 'ready'
  )
  const readyRoleLaunches = workerRoles
    .map((role) => ({
      role,
      tasks: readyTasks.filter((task) => task.role === role),
      agent: roster.find((candidate) => candidate.role === role),
    }))
    .filter((entry) => entry.tasks.length > 0)
  const spawnDialogAgent = spawnDialog ? rosterById[spawnDialog.agentId] : undefined
  const spawnDialogRuntime = spawnDialog
    ? runtimeAgents.find((agent) => agent.agentId === spawnDialog.agentId)
    : undefined
  const spawnDialogAgentState = spawnDialog ? agents[spawnDialog.agentId] : undefined
  const spawnDialogIsRunning = Boolean(spawnDialogAgentState?.cliStartRequested)
  const selectedCliOption = cliOptions.find((option) => option.value === spawnDialog?.cli) ?? cliOptions[0]
  const selectedRecoveryCliOption =
    cliOptions.find((option) => option.value === recoveryDialog?.cli) ?? cliOptions[0]
  const fullGoal = formatSwarmGoal(swarmState.goal)
  const goalPreview = formatSwarmGoalPreview(swarmState.goal)
  const canExpandGoal = fullGoal !== goalPreview || fullGoal.length > 120

  const activateView = (view: SwarmView) => {
    if (fixedView) return
    setActiveView(view)
  }

  const openAddMemberDialog = () => {
    const uncoveredRole = addableRoles.find((role) =>
      swarmState.tasks.some((task) => task.role === role && task.status !== 'done')
      && !roster.some((agent) => agent.role === role)
    )
    setAddMemberRole(uncoveredRole ?? 'developer')
    setAddMemberOpen(true)
  }

  const confirmAddMember = () => {
    const addedAgent = addSwarmMember(workspaceId, addMemberRole)
    if (!addedAgent) return

    startAgentTerminal(addedAgent.id, addedAgent.label)
    setSelectedAgentId(addedAgent.id)
    setAddMemberOpen(false)
  }

  const startAgentTerminal = (
    agentId: string,
    label: string,
    cli?: AgentCli,
    options?: { startupPrompt?: string; freshSession?: boolean }
  ) => {
    const current = agents[agentId]
    const selectedCli = cli ?? current?.cli ?? 'codex'
    const hasLegacyLaunchedSession =
      current?.cli === undefined
      && Boolean(current?.cliStartRequested || current?.cliHasLaunched || current?.cliSessionId)
    const shouldResetSession =
      hasLegacyLaunchedSession || (current?.cli !== undefined && current.cli !== selectedCli)
    const shouldStartFresh = Boolean(options?.freshSession || shouldResetSession)
    updateAgent(workspaceId, agentId, {
      cliStartRequested: true,
      cliSessionId: current?.cliStartRequested && current.cliSessionId && !shouldStartFresh
        ? current.cliSessionId
        : crypto.randomUUID(),
      cliHasLaunched: current?.cliStartRequested && !shouldStartFresh ? current.cliHasLaunched ?? false : false,
      cliOnboardingPromptSent: current?.cliStartRequested && !shouldStartFresh ? current.cliOnboardingPromptSent ?? false : false,
      cli: selectedCli,
      cliStartupPrompt: options?.startupPrompt,
    })
    focusOrAddAgentTab(workspaceId, agentId, label)
  }

  const openAgentTerminal = (agentId: string) => {
    const label = rosterById[agentId]?.label ?? agentId
    setSelectedAgentId(agentId)
    startAgentTerminal(agentId, label)
  }

  const openSpawnDialog = (agentId: string) => {
    const agentState = agents[agentId]
    setSelectedAgentId(agentId)
    setCliPickerOpen(false)
    setSpawnDialog({
      agentId,
      cli: agentState?.cliStartRequested ? agentState.cli ?? 'codex' : 'codex',
    })
  }

  const confirmSpawnDialog = () => {
    if (!spawnDialog) return
    const label = rosterById[spawnDialog.agentId]?.label ?? spawnDialog.agentId
    startAgentTerminal(spawnDialog.agentId, label, spawnDialog.cli)
    setCliPickerOpen(false)
    setSpawnDialog(null)
  }

  const openSpawnDialogForRole = (role: SwarmRole) => {
    const existing = roster.find((agent) => agent.role === role && !agents[agent.id]?.cliStartRequested)
      ?? roster.find((agent) => agent.role === role)
    const agent = existing ?? addSwarmMember(workspaceId, role)
    if (!agent) return

    openSpawnDialog(agent.id)
  }

  const loadPlanReview = async () => {
    if (!swarmState || !folderPath) {
      setPlanReview((current) => ({
        ...current,
        open: true,
        status: 'error',
        error: 'Choose a workspace folder before reviewing the swarm plan.',
      }))
      return
    }

    const swarmRootDirectory = getSwarmRootDirectoryPath(folderPath)
    const swarmDirectory = getSwarmDirectoryPath(folderPath, swarmName)
    const nextPlanFilePath = getSwarmPlanFilePath(folderPath, swarmName)
    setPlanReview((current) => ({
      ...current,
      open: true,
      status: 'loading',
      error: null,
    }))

    try {
      await window.api.ensureDir(folderPath, 'swarm')
      await window.api.ensureDir(swarmRootDirectory, slugifySwarmName(swarmName))

      let content = ''
      try {
        content = await window.api.readfile(nextPlanFilePath)
      } catch {
        content = ''
      }

      setPlanReview((current) => ({
        ...current,
        open: true,
        status: 'ready',
        content,
        error: null,
      }))
    } catch (error) {
      setPlanReview((current) => ({
        ...current,
        open: true,
        status: 'error',
        content: '',
        error: error instanceof Error ? error.message : `Failed to load plan from ${swarmDirectory}.`,
      }))
    }
  }

  const openPlanInEditor = async () => {
    if (!planFilePath) return
    let content = planReview.content
    if (!content) {
      try {
        content = await window.api.readfile(planFilePath)
      } catch {
        content = ''
      }
    }
    openFile(workspaceId, planFilePath, 'plan.md', content)
    focusOrAddComponentTab(workspaceId, 'editor', 'Editor')
    setPlanReview((current) => ({ ...current, open: false }))
  }

  const openRecoveryDialog = () => {
    setCliPickerOpen(false)
    setRecoveryDialog({ cli: 'codex' })
  }

  const confirmRecoveryAudit = () => {
    if (!recoveryDialog || !architectAgentId || !folderPath) return
    const label = rosterById[architectAgentId]?.label ?? 'Architect'

    startAgentTerminal(architectAgentId, label, recoveryDialog.cli, {
      freshSession: true,
      startupPrompt: buildRecoveryAuditPrompt(),
    })
    setSelectedAgentId(architectAgentId)
    setCliPickerOpen(false)
    setRecoveryDialog(null)
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#08090b] text-[#ececee]">
      <div className="border-b border-[#1f2025] bg-[#0d0e11] px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[#24252b] bg-[#111216] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#9a9aa2]">
              {readyRoleLaunches.length > 0 ? 'Ready Work' : 'Manual Swarm Launch'}
            </div>
            <div className="mt-1 text-sm font-medium text-[#ececee]">
              {readyRoleLaunches.length > 0
                ? `${readyTasks.length} ready ${readyTasks.length === 1 ? 'task needs' : 'tasks need'} specialist attention.`
                : 'Review the architect plan, then spawn the specialists you want to run.'}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {readyRoleLaunches.map(({ role, agent }) => {
              const isRunning = agent ? Boolean(agents[agent.id]?.cliStartRequested) : false
              const label = agent?.label ?? swarmRoleLabels[role]
              return (
                <button
                  key={role}
                  onClick={() => openSpawnDialogForRole(role)}
                  className="rounded-md border border-[#6ee7d8]/35 bg-[#6ee7d8]/12 px-4 py-2 text-sm font-semibold text-[#d8fffb] transition-colors hover:border-[#6ee7d8]/60 hover:bg-[#6ee7d8]/18"
                >
                  {isRunning ? `Focus ${label}` : `Spawn ${label}`}
                </button>
              )
            })}
            {architectAgentId && readyRoleLaunches.length === 0 ? (
              <button
                onClick={() => openAgentTerminal(architectAgentId)}
                className="rounded-md border border-[#ffbf2f]/45 bg-[#ffbf2f]/12 px-4 py-2 text-sm font-semibold text-[#ffe0a3] shadow-[0_0_20px_rgba(255,191,47,0.1)] transition-colors hover:border-[#ffbf2f]/70 hover:bg-[#ffbf2f]/16"
              >
                {agents[architectAgentId]?.cliStartRequested ? 'Focus Architect' : 'Spawn Architect'}
              </button>
            ) : null}
            {architectAgentId ? (
              <button
                onClick={openRecoveryDialog}
                className="rounded-md border border-[#30d158]/40 bg-[#30d158]/12 px-4 py-2 text-sm font-semibold text-[#b9f7c8] shadow-[0_0_20px_rgba(48,209,88,0.08)] transition-colors hover:border-[#30d158]/65 hover:bg-[#30d158]/16"
              >
                Verify Progress
              </button>
            ) : null}
            <button
              onClick={() => void loadPlanReview()}
              className="rounded-md border border-[#ffbf2f]/55 bg-[#ffbf2f]/14 px-4 py-2 text-sm font-semibold text-[#ffe0a3] shadow-[0_0_22px_rgba(255,191,47,0.12)] transition-colors hover:border-[#ffbf2f]/80 hover:bg-[#ffbf2f]/18"
            >
              Review Plan
            </button>
          </div>
        </div>

        {allTasksDone ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[#30d158]/35 bg-[#30d158]/12 px-4 py-3 shadow-[0_0_30px_rgba(48,209,88,0.08)]">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#30d158]">
                Run Complete
              </div>
              <div className="mt-1 text-sm font-medium text-[#d4ffdc]">
                All tasks are done. Review the uncommitted workspace changes and manually test the feature.
              </div>
              <div className="mt-1 text-[12px] text-[#b9f7c8]/80">
                {runSummary.touchedFiles.length} files touched, {runSummary.commandsRan.length} commands recorded, {runSummary.results.length} validation results.
              </div>
            </div>
            <button
              onClick={() => setShowRunSummary(true)}
              className="rounded-md border border-[#30d158]/55 bg-[#30d158] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#69e783]"
            >
              View Run Summary
            </button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5a5a63]">
              {swarmState.name}
            </div>
            <button
              type="button"
              onClick={() => {
                if (canExpandGoal) setGoalExpanded((current) => !current)
              }}
              aria-expanded={goalExpanded}
              className={`mt-2 flex w-full max-w-5xl items-start justify-between gap-3 rounded-lg border border-[#24252b] bg-[#111216] px-3 py-2 text-left transition-colors ${
                canExpandGoal ? 'cursor-pointer hover:border-[#303139] hover:bg-[#17181d]' : 'cursor-default'
              } ${goalExpanded ? 'max-h-40 overflow-y-auto' : ''}`}
            >
              <span className={`min-w-0 flex-1 text-[13px] font-medium leading-5 text-[#ececee] ${goalExpanded ? 'whitespace-pre-wrap' : 'truncate'}`}>
                {goalExpanded ? fullGoal : goalPreview}
              </span>
              {canExpandGoal ? (
                <svg
                  className={`mt-0.5 h-4 w-4 shrink-0 text-[#5a5a63] transition-transform ${goalExpanded ? 'rotate-180' : ''}`}
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[#9a9aa2]">
            <span><span className="text-[#5a5a63]">Phase</span> <span className="capitalize text-[#d7d7dc]">{runPhase}</span></span>
            <span><span className="text-[#5a5a63]">Tasks</span> <span className="text-[#d7d7dc]">{swarmState.tasks.length}</span></span>
            <span><span className="text-[#5a5a63]">Done</span> <span className="text-[#d7d7dc]">{doneCount}/{swarmState.tasks.length}</span></span>
            <span><span className="text-[#5a5a63]">Active</span> <span className="text-[#d7d7dc]">{activeCount} running, {needsInputCount} waiting</span></span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={openAddMemberDialog}
            className="rounded-md border border-[#24252b] bg-[#111216] px-3 py-1.5 text-sm font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
          >
            More Roles
          </button>
        </div>

        {!fixedView ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {([
              { id: 'map' as const, label: 'Map' },
              { id: 'kanban' as const, label: 'Kanban' },
            ]).map((view) => (
              <button
                key={view.id}
                onClick={() => activateView(view.id)}
                className={`rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors ${
                  effectiveView === view.id
                    ? 'border-[#30d158]/45 bg-[#30d158]/15 text-[#ececee]'
                    : 'border-[#24252b] bg-[#111216] text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
                }`}
              >
                {view.label}
              </button>
            ))}
          </div>
        ) : null}

      </div>

      {effectiveView === 'map' ? (
        <SwarmMapView
          workspaceId={workspaceId}
          swarmState={swarmState}
          roster={roster}
          rosterById={rosterById}
          runtimeAgents={runtimeAgents}
          runPhase={runPhase}
          selectedAgentId={resolvedSelectedAgentId}
          onSelectAgent={openSpawnDialog}
        />
      ) : null}

      {effectiveView === 'kanban' ? (
      <div className="grid flex-1 gap-3 overflow-x-auto overflow-y-hidden bg-[#08090b] p-4 lg:grid-cols-3 xl:grid-cols-5">
        {swarmState.tasks.length === 0 ? (
          <div className="col-span-full flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-[#24252b] bg-[#0d0e11] p-6 text-center">
            <div className="max-w-xl">
              <div className="text-sm font-semibold text-[#ececee]">Waiting for the architect plan</div>
              <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">
                The board will populate as the architect adds tasks through the swarm tool.
              </p>
            </div>
          </div>
        ) : null}
        {swarmState.tasks.length > 0 ? boardColumns.map((column) => (
          <section
            key={column.key}
            className="flex min-w-[260px] flex-col rounded-2xl border border-[#1f2025] bg-[#0d0e11]"
          >
            <div className="flex items-center justify-between border-b border-[#1f2025] px-4 py-3">
              <div className="text-sm font-semibold text-[#ececee]">{column.label}</div>
              <span
                className={`rounded-full border border-[#24252b] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${column.tint}`}
              >
                {column.cards.length}
              </span>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-3">
              {column.cards.map((task) => {
                const ownerLabel = getTaskOwnerLabel(task, rosterById)
                return (
                  <button
                    key={task.id}
                    onClick={() => setSelectedTaskId(task.id)}
                    className={`w-full rounded-xl border p-3 text-left transition-colors ${taskCardTone(task)}`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[#ececee]">{task.title}</div>
                        <div className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[#5a5a63]">
                          <span>{task.id}</span>
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{
                              backgroundColor: swarmRoleAccent[task.role],
                              boxShadow: `0 0 8px ${swarmRoleAccent[task.role]}88`,
                            }}
                          />
                          <span style={{ color: swarmRoleAccent[task.role] }}>
                            {swarmRoleLabels[task.role]}
                          </span>
                        </div>
                      </div>
                      <span className="rounded-full border border-[#24252b] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[#5a5a63]">
                        {ownerLabel}
                      </span>
                    </div>

                    <p className="text-[12px] leading-5 text-[#9a9aa2]">{task.description}</p>

                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.12em] text-[#5a5a63]">
                      <span className="rounded-full border border-[#24252b] px-2 py-1">
                        {task.ownedPaths.length} paths
                      </span>
                      <span className="rounded-full border border-[#24252b] px-2 py-1">
                        {task.acceptanceCriteria.length} checks
                      </span>
                      {task.dependsOn.length > 0 ? (
                        <span className="rounded-full border border-[#24252b] px-2 py-1">
                          {task.dependsOn.length} deps
                        </span>
                      ) : null}
                      {task.status === 'done' && task.completedAt ? (
                        <span className="rounded-full border border-[#30d158]/25 bg-[#30d158]/10 px-2 py-1 text-[#b9f7c8]">
                          completed {formatTimestampShort(task.completedAt)}
                        </span>
                      ) : null}
                    </div>

                    {task.status === 'done' && task.evidence.summary ? (
                      <div className="mt-3 rounded-lg border border-[#30d158]/20 bg-[#30d158]/10 px-3 py-2 text-[11px] leading-5 text-[#c8f8d3]">
                        {task.evidence.summary}
                      </div>
                    ) : task.notes[0] ? (
                      <div className="mt-3 rounded-lg border border-[#1f2025] bg-[#111216] px-3 py-2 text-[11px] leading-5 text-[#9a9aa2]">
                        {task.notes[0]}
                      </div>
                    ) : null}
                  </button>
                )
              })}

              {column.cards.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#24252b] bg-[#111216] px-3 py-4 text-[12px] text-[#5a5a63]">
                  No tasks here yet
                </div>
              ) : null}
            </div>
          </section>
        )) : null}
      </div>
      ) : null}

      {recoveryDialog ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#30d158]">
                  Verify Progress
                </div>
                <h3 className="truncate text-[20px] font-semibold tracking-tight text-[#ececee]">
                  Architect Audit
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">
                  The Architect will back up state.yaml, check each task in order, and update task status through the swarm Python tool.
                </p>
              </div>
              <button
                onClick={() => {
                  setCliPickerOpen(false)
                  setRecoveryDialog(null)
                }}
                className="rounded-md border border-[#303139] bg-[#111216] px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Close
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <InfoCard label="Tasks" value={`${swarmState.tasks.length} to check`} />
                <InfoCard label="Backup" value="state-timestamp.yaml" />
              </div>

              <div className="relative">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Architect CLI
                </div>
                <button
                  type="button"
                  onClick={() => setCliPickerOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={cliPickerOpen}
                  className="flex min-h-[58px] w-full items-center gap-3 rounded-lg border border-[#303139] bg-[#0d0e11] px-3 text-left text-[#ececee] outline-none transition-colors hover:border-[#3a3b44] hover:bg-[#17181d] focus:border-[#6ee7d8]/60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#303139] bg-[#111216] text-[#6ee7d8]">
                    <CliIcon cli={selectedRecoveryCliOption.value} className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[#ececee]">
                      {selectedRecoveryCliOption.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-[#5a5a63]">
                      {selectedRecoveryCliOption.description}
                    </span>
                  </span>
                  <svg
                    className={`h-4 w-4 shrink-0 text-[#5a5a63] transition-transform ${cliPickerOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {cliPickerOpen ? (
                  <div
                    role="listbox"
                    className="absolute left-0 right-0 top-[76px] z-30 overflow-hidden rounded-lg border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                  >
                    {cliOptions.map((option) => {
                      const selected = recoveryDialog.cli === option.value
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setRecoveryDialog((current) =>
                              current ? { ...current, cli: option.value } : current
                            )
                            setCliPickerOpen(false)
                          }}
                          className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
                            selected
                              ? 'bg-[#6ee7d8]/12 text-[#ececee]'
                              : 'text-[#d7d7dc] hover:bg-[#17181d] hover:text-[#ececee]'
                          }`}
                        >
                          <span
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${
                              selected
                                ? 'border-[#6ee7d8]/40 bg-[#061210] text-[#6ee7d8]'
                                : 'border-[#303139] bg-[#111216] text-[#5a5a63]'
                            }`}
                          >
                            <CliIcon cli={option.value} className="h-5 w-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold">{option.label}</span>
                            <span className="mt-0.5 block truncate text-[12px] text-[#5a5a63]">
                              {option.description}
                            </span>
                          </span>
                          {selected ? (
                            <svg className="h-4 w-4 shrink-0 text-[#6ee7d8]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
                              <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>

              <div className="rounded-lg border border-[#24252b] bg-[#111216] px-4 py-3 text-sm leading-6 text-[#d7d7dc]">
                No app-side recovery state is created. The Architect performs the audit in the terminal and updates the watched state file directly.
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
              <button
                onClick={() => {
                  setCliPickerOpen(false)
                  setRecoveryDialog(null)
                }}
                className="rounded-md border border-[#303139] bg-[#111216] px-4 py-2 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
              <button
                onClick={confirmRecoveryAudit}
                disabled={!folderPath || !architectAgentId}
                className="rounded-md border border-[#30d158]/55 bg-[#30d158] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#69e783] disabled:opacity-45 disabled:hover:bg-[#30d158]"
              >
                Start Audit
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {spawnDialog && spawnDialogAgent ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#6ee7d8]">
                  Spawn Agent
                </div>
                <h3 className="truncate text-[20px] font-semibold tracking-tight text-[#ececee]">
                  {spawnDialogAgent.label}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">
                  Choose the CLI for this specialist, then open its terminal on the right.
                </p>
              </div>
              <button
                onClick={() => {
                  setCliPickerOpen(false)
                  setSpawnDialog(null)
                }}
                className="rounded-md border border-[#303139] bg-[#111216] px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Close
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <InfoCard label="Role" value={swarmRoleLabels[spawnDialogAgent.role]} />
                <InfoCard label="Status" value={runtimeStatusLabel(spawnDialogRuntime?.status ?? 'idle')} />
              </div>

              <div className="relative">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  CLI
                </div>
                <button
                  type="button"
                  onClick={() => setCliPickerOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={cliPickerOpen}
                  className="flex min-h-[58px] w-full items-center gap-3 rounded-lg border border-[#303139] bg-[#0d0e11] px-3 text-left text-[#ececee] outline-none transition-colors hover:border-[#3a3b44] hover:bg-[#17181d] focus:border-[#6ee7d8]/60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#303139] bg-[#111216] text-[#6ee7d8]">
                    <CliIcon cli={selectedCliOption.value} className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[#ececee]">
                      {selectedCliOption.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-[#5a5a63]">
                      {selectedCliOption.description}
                    </span>
                  </span>
                  <svg
                    className={`h-4 w-4 shrink-0 text-[#5a5a63] transition-transform ${cliPickerOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {cliPickerOpen ? (
                  <div
                    role="listbox"
                    className="absolute left-0 right-0 top-[76px] z-30 overflow-hidden rounded-lg border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                  >
                    {cliOptions.map((option) => {
                      const selected = spawnDialog.cli === option.value
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setSpawnDialog((current) =>
                              current ? { ...current, cli: option.value } : current
                            )
                            setCliPickerOpen(false)
                          }}
                          className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
                            selected
                              ? 'bg-[#6ee7d8]/12 text-[#ececee]'
                              : 'text-[#d7d7dc] hover:bg-[#17181d] hover:text-[#ececee]'
                          }`}
                        >
                          <span
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${
                              selected
                                ? 'border-[#6ee7d8]/40 bg-[#061210] text-[#6ee7d8]'
                                : 'border-[#303139] bg-[#111216] text-[#5a5a63]'
                            }`}
                          >
                            <CliIcon cli={option.value} className="h-5 w-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold">{option.label}</span>
                            <span className="mt-0.5 block truncate text-[12px] text-[#5a5a63]">
                              {option.description}
                            </span>
                          </span>
                          {selected ? (
                            <svg className="h-4 w-4 shrink-0 text-[#6ee7d8]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
                              <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>

              <div className="rounded-lg border border-[#24252b] bg-[#111216] px-4 py-3 text-sm leading-6 text-[#d7d7dc]">
                {cliOptions.find((option) => option.value === spawnDialog.cli)?.description}
                {spawnDialogIsRunning ? (
                  <span className="text-[#5a5a63]"> A terminal already exists, so this will focus it unless you changed the CLI.</span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
              <button
                onClick={() => {
                  setCliPickerOpen(false)
                  setSpawnDialog(null)
                }}
                className="rounded-md border border-[#303139] bg-[#111216] px-4 py-2 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
              <button
                onClick={confirmSpawnDialog}
                className="rounded-md border border-[#6ee7d8]/50 bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea]"
              >
                {spawnDialogIsRunning ? 'Open Terminal' : 'Spawn'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedTask && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[900px] overflow-y-auto rounded-2xl border border-[#303139] bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Task Detail
                </div>
                <h3 className="text-[20px] font-semibold tracking-tight text-[#ececee]">
                  {selectedTask.title}
                </h3>
                <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.12em] text-[#5a5a63]">
                  <span className="rounded-full border border-[#303139] px-2 py-1">{selectedTask.id}</span>
                  <span className="rounded-full border border-[#303139] px-2 py-1">
                    {swarmRoleLabels[selectedTask.role]}
                  </span>
                  <span className="rounded-full border border-[#303139] px-2 py-1">
                    {taskStateLabel[selectedTask.status]}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedTaskId(null)}
                className="rounded-lg border border-[#303139] bg-[#111216] px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Close
              </button>
            </div>

            <div className="space-y-5 px-5 py-5 text-[13px] leading-6 text-[#d7d7dc]">
              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Description
                </div>
                <p>{selectedTask.description}</p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <InfoCard
                  label="Owner"
                  value={getTaskOwnerLabel(selectedTask, rosterById)}
                />
                <InfoCard
                  label="Dependencies"
                  value={selectedTask.dependsOn.join(', ') || 'None'}
                />
                <InfoCard
                  label="Started"
                  value={formatTimestamp(selectedTask.startedAt)}
                />
              </div>

              {selectedTask.ownerAgentId ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#24252b] bg-[#111216] px-4 py-3">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                      Worker CLI
                    </div>
                    <div className="mt-1 text-sm text-[#d7d7dc]">
                      Jump straight to {rosterById[selectedTask.ownerAgentId]?.label ?? selectedTask.ownerAgentId} to continue or answer questions there.
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      openAgentTerminal(selectedTask.ownerAgentId!)
                      setSelectedTaskId(null)
                    }}
                    className="rounded-xl border border-[#303139] bg-[#111216] px-4 py-2 text-sm font-semibold text-[#ececee] transition-colors hover:bg-[#17181d]"
                  >
                    Focus Worker CLI
                  </button>
                </div>
              ) : null}

              <SectionList title="Owned Paths" items={selectedTask.ownedPaths} emptyLabel="No owned paths recorded." />
              <SectionList
                title="Acceptance Criteria"
                items={selectedTask.acceptanceCriteria}
                emptyLabel="No acceptance criteria recorded."
              />
              <SectionList
                title="Implementation Notes"
                items={selectedTask.implementationNotes}
                emptyLabel="No implementation notes recorded."
              />
              <SectionList title="Notes" items={selectedTask.notes} emptyLabel="No notes recorded." />
              {selectedTask.status === 'needs_input' ? (
                <div className="rounded-2xl border border-[#ffbf2f]/65 bg-[#ffbf2f]/12 px-4 py-3 text-sm text-[#ffe0a3] shadow-[0_0_24px_rgba(255,191,47,0.12)]">
                  Respond in the highlighted CLI for this worker. The terminal stays the single place to unblock the task.
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <SectionList
                  title="Commands Run"
                  items={selectedTask.evidence.commandsRan}
                  emptyLabel="No commands recorded."
                />
                <SectionList
                  title="Results"
                  items={selectedTask.evidence.results}
                  emptyLabel="No test or validation results recorded."
                />
              </div>

              <SectionList
                title="Touched Files"
                items={selectedTask.evidence.touchedFiles}
                emptyLabel="No touched files recorded."
              />

              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Evidence Summary
                </div>
                <div className="rounded-xl border border-[#24252b] bg-[#111216] px-4 py-3 text-[#d7d7dc]">
                  {selectedTask.evidence.summary || 'No completion summary recorded yet.'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRunSummary ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[980px] overflow-y-auto rounded-2xl border border-[#30d158]/35 bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55),0_0_28px_rgba(48,209,88,0.1)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#30d158]">
                  Run Summary
                </div>
                <h3 className="text-[14px] font-semibold tracking-tight text-[#ececee]">
                  {formatSwarmGoal(swarmState.goal)}
                </h3>
                <p className="mt-2 text-sm text-[#9a9aa2]">
                  Final evidence collected from completed swarm task cards.
                </p>
              </div>
              <button
                onClick={() => setShowRunSummary(false)}
                className="rounded-lg border border-[#303139] bg-[#111216] px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Close
              </button>
            </div>

            <div className="space-y-5 px-5 py-5 text-[13px] leading-6 text-[#d7d7dc]">
              <div className="grid gap-4 md:grid-cols-4">
                <InfoCard label="Tasks Done" value={`${runSummary.completedTasks}/${runSummary.totalTasks}`} />
                <InfoCard label="Files Touched" value={String(runSummary.touchedFiles.length)} />
                <InfoCard label="Commands" value={String(runSummary.commandsRan.length)} />
                <InfoCard label="Results" value={String(runSummary.results.length)} />
              </div>

              <SectionList
                title="Completed Tasks"
                items={runSummary.taskSummaries}
                emptyLabel="No completed tasks recorded."
              />
              <SectionList
                title="Touched Files"
                items={runSummary.touchedFiles}
                emptyLabel="No touched files recorded."
              />
              <SectionList
                title="Commands Run"
                items={runSummary.commandsRan}
                emptyLabel="No commands recorded."
              />
              <SectionList
                title="Validation Results"
                items={runSummary.results}
                emptyLabel="No validation results recorded."
              />
              <SectionList
                title="Remaining Questions"
                items={runSummary.openQuestions}
                emptyLabel="No open questions remain."
              />

              <div className="rounded-2xl border border-[#ffbf2f]/45 bg-[#ffbf2f]/10 px-4 py-3 text-sm text-[#ffe0a3] shadow-[0_0_22px_rgba(255,191,47,0.1)]">
                Next step: manually test the uncommitted changes in the workspace before committing or reverting.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {addMemberOpen ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[760px] overflow-y-auto rounded-2xl border border-[#303139] bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Swarm Roster
                </div>
                <h3 className="text-[20px] font-semibold tracking-tight text-[#ececee]">
                  Spawn Team Member
                </h3>
              </div>
              <button
                onClick={() => setAddMemberOpen(false)}
                className="rounded-lg border border-[#303139] bg-[#111216] px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Close
              </button>
            </div>

            <div className="grid gap-3 px-5 py-5 sm:grid-cols-2">
              {addableRoles.map((role) => {
                const selected = role === addMemberRole
                const activeForRole = roster.filter((agent) => agent.role === role).length
                const openTasksForRole = swarmState.tasks.filter(
                  (task) => task.role === role && task.status !== 'done'
                ).length

                return (
                  <button
                    key={role}
                    onClick={() => setAddMemberRole(role)}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      selected
                        ? 'border-[#6ee7d8]/55 bg-[#6ee7d8]/12 text-[#ececee]'
                        : 'border-[#24252b] bg-[#111216] text-[#d7d7dc] hover:border-[#303139] hover:bg-[#17181d]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">
                          {swarmRoleLabels[role]}
                        </div>
                        <p className={`mt-2 text-[12px] leading-5 ${selected ? 'text-[#bff7f1]' : 'text-[#9a9aa2]'}`}>
                          {roleSummaries[role]}
                        </p>
                      </div>
                      <span
                        className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: swarmRoleAccent[role] }}
                      />
                    </div>

                    <div className={`mt-4 flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-[0.12em] ${
                      selected ? 'text-[#bff7f1]' : 'text-[#5a5a63]'
                    }`}>
                      <span className={`rounded-full border px-2 py-1 ${
                        selected ? 'border-[#6ee7d8]/40 bg-[#6ee7d8]/10' : 'border-[#303139] bg-[#0d0e11]'
                      }`}>
                        {activeForRole} active
                      </span>
                      <span className={`rounded-full border px-2 py-1 ${
                        selected ? 'border-[#6ee7d8]/40 bg-[#6ee7d8]/10' : 'border-[#303139] bg-[#0d0e11]'
                      }`}>
                        {openTasksForRole} open
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
              <button
                onClick={() => setAddMemberOpen(false)}
                className="rounded-xl border border-[#303139] bg-[#111216] px-4 py-2 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
              <button
                onClick={confirmAddMember}
                className="rounded-xl border border-[#6ee7d8]/50 bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea]"
              >
                Spawn {swarmRoleLabels[addMemberRole]}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {planReview.open ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border border-[#ffbf2f]/45 bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55),0_0_32px_rgba(255,191,47,0.12)]">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#ffbf2f]">
                  Architect Plan Review
                </div>
                <h3 className="truncate text-[20px] font-semibold tracking-tight text-[#ececee]">
                  {planFilePath ?? 'swarm/plan.md'}
                </h3>
                <p className="mt-2 text-sm text-[#9a9aa2]">
                  Review the architect-authored low-level design before spawning specialists.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() =>
                    setPlanReview((current) => ({
                      ...current,
                      mode: current.mode === 'preview' ? 'source' : 'preview',
                    }))
                  }
                  className="rounded-lg border border-[#303139] bg-[#111216] px-3 py-2 text-sm text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                >
                  {planReview.mode === 'preview' ? 'Source' : 'Preview'}
                </button>
                <button
                  onClick={() => void loadPlanReview()}
                  className="rounded-lg border border-[#303139] bg-[#111216] px-3 py-2 text-sm text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                >
                  Refresh
                </button>
                {architectAgentId ? (
                  <button
                    onClick={() => openAgentTerminal(architectAgentId)}
                    className="rounded-lg border border-[#ffbf2f]/45 bg-[#ffbf2f]/12 px-3 py-2 text-sm text-[#ffe0a3] transition-colors hover:border-[#ffbf2f]/70 hover:bg-[#ffbf2f]/16"
                  >
                    Focus Architect
                  </button>
                ) : null}
                <button
                  onClick={() => setPlanReview((current) => ({ ...current, open: false }))}
                  className="rounded-lg border border-[#303139] bg-[#111216] px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {planReview.status === 'loading' ? (
                <div className="rounded-2xl border border-[#24252b] bg-[#111216] px-4 py-5 text-sm text-[#9a9aa2]">
                  Loading plan...
                </div>
              ) : null}
              {planReview.status === 'error' ? (
                <div className="rounded-2xl border border-[#ff1a3d]/45 bg-[#ff1a3d]/12 px-4 py-5 text-sm text-[#ffb3bf]">
                  {planReview.error ?? 'Failed to load plan.'}
                </div>
              ) : null}
              {planReview.status === 'ready' && planReview.mode === 'preview' ? (
                <div className="mx-auto max-w-4xl">
                  {planReview.content
                    ? renderMarkdown(planReview.content)
                    : (
                      <div className="rounded-lg border border-dashed border-[#303139] bg-[#111216] px-4 py-5 text-sm text-[#9a9aa2]">
                        No architect plan has been written yet.
                      </div>
                    )}
                </div>
              ) : null}
              {planReview.status === 'ready' && planReview.mode === 'source' ? (
                <pre className="min-h-[420px] overflow-x-auto rounded-2xl border border-[#24252b] bg-[#08090b] p-4 text-[13px] leading-6 text-[#d7d7dc]">
                  <code>{planReview.content}</code>
                </pre>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
              <div className="text-[12px] text-[#5a5a63]">
                Spawn specialists from the board header when this plan matches your intent.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {planFilePath ? (
                  <button
                    onClick={() => void openPlanInEditor()}
                    className="rounded-xl border border-[#303139] bg-[#111216] px-4 py-2 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d]"
                  >
                    Open in Editor
                  </button>
                ) : null}
                <button
                  onClick={() => setPlanReview((current) => ({ ...current, open: false }))}
                  className="rounded-xl border border-[#ffbf2f]/55 bg-[#ffbf2f]/14 px-4 py-2 text-sm font-semibold text-[#ffe0a3] shadow-[0_0_22px_rgba(255,191,47,0.12)] transition-colors hover:border-[#ffbf2f]/80 hover:bg-[#ffbf2f]/18"
                >
                  Done Reviewing
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

type RosterItem = {
  id: string
  label: string
  role: SwarmRole
}

type RuntimeAgentView = {
  agentId: string
  role: SwarmRole
  status: string
  currentTaskId: string | null
}

function SwarmMapView({
  swarmState,
  roster,
  rosterById,
  runtimeAgents,
  runPhase,
  selectedAgentId,
  onSelectAgent,
}: {
  workspaceId: string
  swarmState: SwarmState
  roster: RosterItem[]
  rosterById: Record<string, RosterItem | undefined>
  runtimeAgents: RuntimeAgentView[]
  runPhase: string
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
}) {
  const selectedAgent = selectedAgentId ? rosterById[selectedAgentId] : undefined
  const selectedRuntime = selectedAgentId
    ? runtimeAgents.find((agent) => agent.agentId === selectedAgentId)
    : undefined
  const selectedTask = selectedRuntime?.currentTaskId
    ? swarmState.tasks.find((task) => task.id === selectedRuntime.currentTaskId)
    : null
  const positions = buildMapPositions(roster)
  const doneCount = swarmState.tasks.filter((task) => task.status === 'done').length
  const activeCount = runtimeAgents.filter((agent) => agent.status === 'running').length
  const needsInputCount = runtimeAgents.filter((agent) => agent.status === 'needs_input').length

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-[#08090b] lg:grid-cols-[minmax(0,1fr)_340px]">
      <div
        className="relative min-h-[460px] overflow-hidden"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,0.20) 0, rgba(255,255,255,0.20) 1px, transparent 1px)',
          backgroundColor: '#08090b',
          backgroundSize: '24px 24px',
        }}
      >
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {positions
            .filter((node) => node.agent.role !== 'architect')
            .map((node) => (
              <line
                key={node.agent.id}
                x1="50"
                y1="38"
                x2={node.x}
                y2={node.y}
                stroke={swarmRoleAccent[node.agent.role]}
                strokeWidth="0.18"
                strokeDasharray="1.2 1.8"
                opacity="0.42"
              />
            ))}
        </svg>

        {positions.map((node) => {
          const runtime = runtimeAgents.find((agent) => agent.agentId === node.agent.id)
          const selected = node.agent.id === selectedAgentId
          const task = runtime?.currentTaskId
            ? swarmState.tasks.find((candidate) => candidate.id === runtime.currentTaskId)
            : null

          return (
            <button
              key={node.agent.id}
              onClick={() => onSelectAgent(node.agent.id)}
              className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center transition-transform hover:scale-[1.03] ${
                selected ? 'z-10 scale-[1.04]' : 'z-0'
              }`}
              style={{ left: `${node.x}%`, top: `${node.y}%` }}
            >
              <span
                className={`relative flex h-20 w-20 items-center justify-center rounded-full border bg-[#111216] text-lg font-semibold text-[#ececee] ${
                  runtime?.status === 'running' ? 'animate-pulse' : ''
                }`}
                style={{
                  borderColor: swarmRoleAccent[node.agent.role],
                  boxShadow: `0 0 ${selected ? 34 : 18}px ${swarmRoleAccent[node.agent.role]}55`,
                }}
              >
                {node.agent.label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}
                <span
                  className="absolute -right-1 top-3 h-3 w-3 rounded-full border border-[#08090b]"
                  style={{ backgroundColor: statusColor(runtime?.status ?? 'idle') }}
                />
              </span>
              <span className="max-w-[150px] truncate text-sm font-semibold text-[#ececee]">{node.agent.label}</span>
              <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${runtimeTone(runtime?.status ?? 'idle')}`}>
                {runtimeStatusLabel(runtime?.status ?? 'idle')}
              </span>
              {task ? (
                <span className="max-w-[180px] truncate rounded-full border border-[#24252b] bg-[#111216] px-2 py-1 text-[10px] text-[#9a9aa2]">
                  {task.id}: {task.title}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <aside className="border-t border-[#1f2025] bg-[#0d0e11] p-4 lg:border-l lg:border-t-0">
        <div className="mb-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">Swarm State</div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <InfoCard label="Phase" value={runPhase} />
            <InfoCard label="Board" value={`${swarmState.tasks.length} tasks`} />
            <InfoCard label="Tasks" value={`${doneCount}/${swarmState.tasks.length} done`} />
            <InfoCard label="Agents" value={`${activeCount} run, ${needsInputCount} wait`} />
          </div>
        </div>
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">Selected Specialist</div>
        {selectedAgent ? (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-3">
              <span
                className="flex h-14 w-14 items-center justify-center rounded-full border bg-[#111216] text-base font-semibold text-[#ececee]"
                style={{
                  borderColor: swarmRoleAccent[selectedAgent.role],
                  boxShadow: `0 0 22px ${swarmRoleAccent[selectedAgent.role]}55`,
                }}
              >
                {selectedAgent.label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold text-[#ececee]">{selectedAgent.label}</div>
                <div className="mt-1 text-sm text-[#9a9aa2]">{swarmRoleLabels[selectedAgent.role]}</div>
              </div>
            </div>

            <InfoCard label="Status" value={runtimeStatusLabel(selectedRuntime?.status ?? 'idle')} />
            <InfoCard label="Current Task" value={selectedTask ? `${selectedTask.id} - ${selectedTask.title}` : 'No active task'} />

            {selectedAgent.role === 'product' ? (
              <div className="rounded-xl border border-pink-300/20 bg-pink-950/10 px-3 py-3 text-sm leading-6 text-pink-100">
                Product guides market fit, competitor context, audience needs, workflow risk, and prioritization before the plan hardens.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-[#24252b] bg-[#111216] px-3 py-4 text-sm text-[#5a5a63]">
            Select a specialist on the map.
          </div>
        )}
      </aside>
    </div>
  )
}

function buildMapPositions(roster: RosterItem[]): Array<{ agent: RosterItem; x: number; y: number }> {
  const architect = roster.find((agent) => agent.role === 'architect')
  const others = roster.filter((agent) => agent.role !== 'architect')
  const ordered = [
    ...others.filter((agent) => agent.role === 'product'),
    ...others.filter((agent) => agent.role === 'frontend'),
    ...others.filter((agent) => agent.role === 'developer'),
    ...others.filter((agent) => agent.role === 'tester'),
    ...others.filter((agent) => agent.role === 'security'),
  ]
  const positions: Array<{ agent: RosterItem; x: number; y: number }> = []

  if (architect) {
    positions.push({ agent: architect, x: 50, y: 38 })
  }

  ordered.forEach((agent, index) => {
    const angle = (-105 + (210 / Math.max(1, ordered.length - 1)) * index) * (Math.PI / 180)
    const radiusX = 34
    const radiusY = 30
    positions.push({
      agent,
      x: 50 + Math.cos(angle) * radiusX,
      y: 52 + Math.sin(angle) * radiusY,
    })
  })

  return positions
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return '#38bdf8'
    case 'needs_input':
      return '#ffbf2f'
    case 'planning':
      return '#fbbf24'
    case 'complete':
      return '#34d399'
    case 'error':
      return '#ef4444'
    default:
      return '#71717a'
  }
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#24252b] bg-[#111216] px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#5a5a63]">{label}</div>
      <div className="mt-2 font-medium text-[#ececee]">{value}</div>
    </div>
  )
}

function SectionList({
  title,
  items,
  emptyLabel,
}: {
  title: string
  items: string[]
  emptyLabel: string
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">{title}</div>
      {items.length > 0 ? (
        <ul className="space-y-2 text-[#d7d7dc]">
          {items.map((item) => (
            <li key={item} className="rounded-lg border border-[#24252b] bg-[#111216] px-3 py-2">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-[#24252b] bg-[#111216] px-3 py-3 text-[12px] text-[#5a5a63]">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not started'
  return new Date(value).toLocaleString()
}

function formatTimestampShort(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function taskCardTone(task: SwarmTask): string {
  switch (task.status) {
    case 'done':
      return 'border-[#30d158]/45 bg-[#30d158]/10 shadow-[0_0_22px_rgba(48,209,88,0.08)] hover:border-[#30d158]/70 hover:bg-[#30d158]/14'
    case 'needs_input':
      return 'border-[#ffbf2f]/60 bg-[#ffbf2f]/12 shadow-[0_0_24px_rgba(255,191,47,0.12)] hover:border-[#ffbf2f]/80 hover:bg-[#ffbf2f]/16'
    case 'in_progress':
      return 'border-[#ffa600]/45 bg-[#ffa600]/10 shadow-[0_0_22px_rgba(255,166,0,0.09)] hover:border-[#ffa600]/70 hover:bg-[#ffa600]/14'
    default:
      return 'border-[#24252b] bg-[#111216] hover:border-[#303139] hover:bg-[#17181d]'
  }
}

function runtimeTone(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-[#6ee7d8]/12 text-[#bff7f1]'
    case 'needs_input':
      return 'border border-[#ffbf2f]/55 bg-[#ffbf2f]/14 text-[#ffe0a3] shadow-[0_0_16px_rgba(255,191,47,0.12)]'
    case 'planning':
      return 'bg-[#ffa600]/14 text-[#ffd58a]'
    case 'complete':
      return 'bg-[#30d158]/12 text-[#d4ffdc]'
    case 'error':
      return 'bg-[#ff1a3d]/14 text-[#ffb3bf]'
    default:
      return 'bg-[#1a1b20] text-[#9a9aa2]'
  }
}

function runtimeStatusLabel(status: string): string {
  switch (status) {
    case 'needs_input':
      return 'Needs Input'
    case 'running':
      return 'Running'
    case 'planning':
      return 'Planning'
    case 'complete':
      return 'Complete'
    case 'error':
      return 'Error'
    default:
      return 'Idle'
  }
}

function getTaskOwnerLabel(
  task: SwarmTask,
  rosterById: Record<string, { label: string } | undefined>
): string {
  if (task.ownerAgentId) {
    return rosterById[task.ownerAgentId]?.label ?? task.ownerAgentId
  }

  return task.status === 'done' ? swarmRoleLabels[task.role] : 'Unclaimed'
}

function getRunPhase(swarmState: SwarmState, runtimeAgents: RuntimeAgentView[]): string {
  if (swarmState.tasks.length > 0 && swarmState.tasks.every((task) => task.status === 'done')) {
    return 'Complete'
  }
  if (runtimeAgents.some((agent) => agent.status === 'running' || agent.status === 'needs_input')) {
    return 'Running'
  }
  if (swarmState.tasks.length > 0) {
    return 'Tasked'
  }
  return 'Planning'
}

function formatSwarmGoal(goal: string): string {
  const trimmed = goal.trim()
  if (!trimmed || trimmed.toLowerCase() === 'launch swarm mode') {
    return 'Untitled swarm run'
  }

  return trimmed
}

function formatSwarmGoalPreview(goal: string): string {
  const formatted = formatSwarmGoal(goal)
  if (formatted === 'Untitled swarm run') return formatted

  const firstLine = goal
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) return formatted

  const firstSentence = firstLine.match(/^(.+?[.!?])(?:\s|$)/)?.[1]?.trim()
  return firstSentence || firstLine
}

function buildRecoveryAuditPrompt(): string {
  return [
    'You are starting ALIENCODE Verify Progress recovery mode.',
    '',
    'Do not run `swarm init`.',
    'Run `swarm recover` now.',
    '',
    '`swarm recover` is the canonical recovery entrypoint. It backs up the active state file, returns the full recovery architect prompt, and defines the allowed audit-only commands.',
    'Read the returned JSON `prompt` field and follow it exactly.',
    'If `swarm recover` fails, stop and report the error instead of creating, deleting, or replanning tasks.',
  ].join('\n')
}

function buildRunSummary(tasks: SwarmTask[]) {
  const completed = tasks.filter((task) => task.status === 'done')
  const touchedFiles = uniqueStrings(completed.flatMap((task) => task.evidence.touchedFiles))
  const commandsRan = uniqueStrings(completed.flatMap((task) => task.evidence.commandsRan))
  const results = completed.flatMap((task) =>
    task.evidence.results.map((result) => `${task.id}: ${result}`)
  )
  const taskSummaries = completed.map((task) => {
    const summary = task.evidence.summary.trim() || 'No completion summary recorded.'
    return `${task.id} - ${task.title}: ${summary}`
  })
  const openQuestions = tasks.flatMap((task) =>
    task.notes.map((note) => `${task.id}: ${note}`)
  )

  return {
    totalTasks: tasks.length,
    completedTasks: completed.length,
    touchedFiles,
    commandsRan,
    results,
    taskSummaries,
    openQuestions,
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}
