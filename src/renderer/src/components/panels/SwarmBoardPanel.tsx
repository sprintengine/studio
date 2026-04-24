import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import type {
  AgentCli,
  AgentState,
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


type PlanReaderState = {
  open: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  content: string
  error: string | null
  mode: 'preview' | 'source'
}

type SwarmView = 'project' | 'map' | 'task-graph' | 'kanban'

type SpawnDialogState = {
  agentId: string
  cli: AgentCli
}

type RecoveryDialogState = {
  cli: AgentCli
}

type AutoPendingSpawn = {
  taskId: string
  agentId: string
}

type SwarmAutoState = {
  enabled: boolean
  pending: AutoPendingSpawn | null
}

const defaultSwarmAutoState: SwarmAutoState = {
  enabled: false,
  pending: null,
}
const swarmAutoStates = new Map<string, SwarmAutoState>()
const swarmAutoListeners = new Map<string, Set<() => void>>()

function getSwarmAutoState(workspaceId: string): SwarmAutoState {
  return swarmAutoStates.get(workspaceId) ?? defaultSwarmAutoState
}

function subscribeSwarmAutoState(workspaceId: string, listener: () => void): () => void {
  const listeners = swarmAutoListeners.get(workspaceId) ?? new Set<() => void>()
  listeners.add(listener)
  swarmAutoListeners.set(workspaceId, listeners)

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) swarmAutoListeners.delete(workspaceId)
  }
}

function updateSwarmAutoState(
  workspaceId: string,
  updater: (current: SwarmAutoState) => SwarmAutoState
) {
  const current = getSwarmAutoState(workspaceId)
  const next = updater(current)
  if (next.enabled === current.enabled && next.pending === current.pending) return

  swarmAutoStates.set(workspaceId, next)
  swarmAutoListeners.get(workspaceId)?.forEach((listener) => listener())
}

function setSwarmAutoEnabled(workspaceId: string, enabled: boolean) {
  updateSwarmAutoState(workspaceId, (current) => ({
    enabled,
    pending: enabled ? current.pending : null,
  }))
}

function setSwarmAutoPending(workspaceId: string, pending: AutoPendingSpawn | null) {
  updateSwarmAutoState(workspaceId, (current) => ({
    ...current,
    pending,
  }))
}

function useSwarmAutoState(workspaceId: string): SwarmAutoState {
  return useSyncExternalStore(
    (listener) => subscribeSwarmAutoState(workspaceId, listener),
    () => getSwarmAutoState(workspaceId),
    () => getSwarmAutoState(workspaceId)
  )
}

function buildWorkerRespawnStartupPrompt(
  role: SwarmRole,
  agentId: string
): string {
  return [
    'Fetch the canonical swarm instructions from the Python tool.',
    'Run:',
    `\`\`\`\nswarm join --role ${role} --id ${agentId}\n\`\`\``,
  ].join('\n\n')
}

export default function SwarmBoardPanel({ workspaceId, fixedView }: Props) {
  const workspace = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null
  )
  const setSwarmState = useWorkspaceStore((s) => s.setSwarmState)
  const addSwarmMember = useWorkspaceStore((s) => s.addSwarmMember)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
  const {
    folderPath: savedFolderPath,
    folderReadyPath,
    folderMissing,
    checkingFolder,
    recheckFolder,
  } = useWorkspaceFolderStatus(workspaceId)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<SwarmView>('project')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [spawnDialog, setSpawnDialog] = useState<SpawnDialogState | null>(null)
  const [recoveryDialog, setRecoveryDialog] = useState<RecoveryDialogState | null>(null)
  const [cliPickerOpen, setCliPickerOpen] = useState(false)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addMemberRole, setAddMemberRole] = useState<SwarmRole>('developer')
  const autoState = useSwarmAutoState(workspaceId)
  const [showRunSummary, setShowRunSummary] = useState(false)
  const [planReader, setPlanReader] = useState<PlanReaderState>({
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
  const folderPath = folderReadyPath
  const agents = workspace?.agents ?? {}
  const swarmName = swarmState?.name ?? workspace?.name ?? 'Swarm Team'
  const autoEnabled = autoState.enabled
  const autoPendingSpawn = autoState.pending

  const roster = useMemo(
    () => buildSwarmAgentRosterForState(swarmState),
    [swarmState]
  )

  const rosterById = useMemo(
    () => Object.fromEntries(roster.map((agent) => [agent.id, agent])),
    [roster]
  )

  useEffect(() => {
    if (!savedFolderPath) {
      setSyncState({
        status: 'idle',
        message: 'Choose a workspace folder to watch agent-managed swarm state.',
      })
      return
    }
    if (!folderPath) {
      setSyncState({
        status: folderMissing ? 'error' : 'idle',
        message: folderMissing
          ? `Saved workspace folder is missing: ${savedFolderPath}`
          : 'Checking workspace folder before watching swarm state.',
      })
      return
    }

    if (initialReadDoneRef.current) return

    let cancelled = false

    const loadStateFile = async () => {
      const stateFilePath = getSwarmStateFilePath(folderPath, swarmName)
      setSyncState({ status: 'syncing', message: 'Loading agent-managed swarm state...' })
      try {
        const content = await window.api.readfile(stateFilePath)
        if (cancelled) return
        const parsed = parseSwarmStateFile(content)
        lastSyncedContentRef.current = content
        setSwarmState(workspaceId, parsed)
        setSyncState({ status: 'live', message: `Watching agent-managed state at ${stateFilePath}` })
      } catch {
        if (cancelled) return
        setSyncState({ status: 'idle', message: `Waiting for agent-managed state at ${stateFilePath}` })
      } finally {
        initialReadDoneRef.current = true
      }
    }

    void loadStateFile()

    return () => {
      cancelled = true
    }
  }, [folderMissing, folderPath, savedFolderPath, setSwarmState, swarmName, workspaceId])

  useEffect(() => {
    if (!folderPath) return

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
        setSyncState({ status: 'live', message: `Watching agent-managed state at ${stateFilePath}` })
      } catch { /* file not yet written */ }
    }

    const startWatching = async () => {
      try {
        // The renderer must never write `state.yaml`. We only watch the
        // agent-managed file and refresh local UI state when the swarm tool
        // changes it.
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
  }, [folderPath, setSwarmState, swarmName, workspaceId])

  const runtimeAgents = useMemo(
    () => roster.map((agent) => ({
      agentId: agent.id,
      role: swarmState?.swarmAgents[agent.id]?.role ?? agent.role,
      status: swarmState?.swarmAgents[agent.id]?.status ?? 'idle',
      currentTaskId: swarmState?.swarmAgents[agent.id]?.currentTaskId ?? null,
    })),
    [roster, swarmState?.swarmAgents]
  )

  const runtimeAgentById = useMemo(
    () => Object.fromEntries(runtimeAgents.map((agent) => [agent.agentId, agent])),
    [runtimeAgents]
  )

  const readyTasks = useMemo(() => (
    swarmState?.tasks.filter(
      (task) => getSwarmTaskBoardColumn(task, swarmState.tasks) === 'ready'
    ) ?? []
  ), [swarmState])

  function startAgentTerminal(
    agentId: string,
    label: string,
    cli?: AgentCli,
    options?: { startupPrompt?: string; freshSession?: boolean }
  ) {
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

  useEffect(() => {
    if (!autoEnabled || !swarmState || !folderPath) return

    const pending = autoPendingSpawn
    if (pending) {
      const pendingTask = swarmState.tasks.find((task) => task.id === pending.taskId)
      const pendingTaskStillReady = pendingTask
        ? getSwarmTaskBoardColumn(pendingTask, swarmState.tasks) === 'ready' && !pendingTask.ownerAgentId
        : false
      const pendingAgentStillLaunching = Boolean(agents[pending.agentId]?.cliStartRequested)

      if (pendingTaskStillReady && pendingAgentStillLaunching) return
      setSwarmAutoPending(workspaceId, null)
    }

    if (runtimeAgents.some((agent) => agent.status === 'needs_input')) {
      setSwarmAutoEnabled(workspaceId, false)
      return
    }

    if (runtimeAgents.some((agent) => agent.status === 'running')) return

    if (swarmState.tasks.length > 0 && swarmState.tasks.every((task) => task.status === 'done')) {
      setSwarmAutoEnabled(workspaceId, false)
      return
    }

    const nextTask = readyTasks.find((task) => !task.ownerAgentId)
    if (!nextTask) {
      setSwarmAutoEnabled(workspaceId, false)
      return
    }

    const existingAgent = roster.find((agent) =>
      agent.role === nextTask.role
      && runtimeAgentById[agent.id]?.status !== 'done'
      && !agents[agent.id]?.cliStartRequested
    )
    const nextAgent = existingAgent ?? addSwarmMember(workspaceId, nextTask.role)
    if (!nextAgent) {
      setSwarmAutoEnabled(workspaceId, false)
      return
    }

    setSwarmAutoPending(workspaceId, { taskId: nextTask.id, agentId: nextAgent.id })
    setSelectedAgentId(nextAgent.id)
    startAgentTerminal(nextAgent.id, nextAgent.label, agents[nextAgent.id]?.cli ?? 'codex', {
      freshSession: true,
    })
  }, [
    addSwarmMember,
    agents,
    autoEnabled,
    autoPendingSpawn,
    folderPath,
    readyTasks,
    roster,
    runtimeAgentById,
    runtimeAgents,
    swarmState,
    updateAgent,
    workspaceId,
  ])

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
  const readyRoleLaunches = workerRoles
    .map((role) => ({
      role,
      tasks: readyTasks.filter((task) => task.role === role),
      agent: roster.find((candidate) =>
        candidate.role === role && runtimeAgentById[candidate.id]?.status !== 'done'
      ),
    }))
    .filter((entry) => entry.tasks.length > 0)
  const specialistReviewAgents = roster.filter((agent) => agent.role !== 'architect')
  const spawnDialogAgent = spawnDialog ? rosterById[spawnDialog.agentId] : undefined
  const spawnDialogRuntime = spawnDialog
    ? runtimeAgents.find((agent) => agent.agentId === spawnDialog.agentId)
    : undefined
  const spawnDialogAgentState = spawnDialog ? agents[spawnDialog.agentId] : undefined
  const spawnDialogIsRunning = Boolean(spawnDialogAgentState?.cliStartRequested)
  const selectedCliOption = cliOptions.find((option) => option.value === spawnDialog?.cli) ?? cliOptions[0]
  const selectedRecoveryCliOption =
    cliOptions.find((option) => option.value === recoveryDialog?.cli) ?? cliOptions[0]
  const hasPlannedTasks = swarmState.tasks.length > 0
  const relinkFolder = async () => {
    const dir = await window.api.openDir()
    if (dir) setFolderPath(workspaceId, dir)
  }
  const folderStatusBanner = savedFolderPath && !folderPath ? (
    <div className="border-b border-[#24252b] bg-[#111216] px-4 py-2 text-[12px] text-[#9a9aa2]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 truncate">
          {checkingFolder ? 'Checking workspace folder...' : `Saved folder is missing: ${savedFolderPath}`}
        </span>
        {folderMissing ? (
          <span className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => void recheckFolder()}
              className="rounded-md border border-[#303139] bg-[#17181d] px-2.5 py-1 text-[11px] font-semibold text-[#d7d7dc] transition-colors hover:bg-[#1d1e24] hover:text-[#ececee]"
            >
              Retry
            </button>
            <button
              onClick={() => void relinkFolder()}
              className="rounded-md border border-[#6ee7d8]/45 bg-[#6ee7d8]/10 px-2.5 py-1 text-[11px] font-semibold text-[#bff7f1] transition-colors hover:bg-[#6ee7d8]/16"
            >
              Relink
            </button>
          </span>
        ) : null}
      </div>
    </div>
  ) : null
  const showPlanningActions = !hasPlannedTasks
  const needsInputAgent = runtimeAgents.find((agent) => agent.status === 'needs_input')
  const runningAgent = runtimeAgents.find((agent) => agent.status === 'running')
  const focusAgent = needsInputAgent ?? runningAgent
  const focusAgentRoster = focusAgent ? rosterById[focusAgent.agentId] : undefined
  const focusAgentIsLaunched = focusAgent ? Boolean(agents[focusAgent.agentId]?.cliStartRequested) : false
  const focusAgentRole = focusAgentRoster?.role ?? focusAgent?.role ?? null
  const selectedTaskBoardColumn = selectedTask
    ? getSwarmTaskBoardColumn(selectedTask, swarmState.tasks)
    : null
  const selectedTaskStatusLabel = selectedTask
    ? selectedTaskBoardColumn === 'ready' ? 'Ready' : taskStateLabel[selectedTask.status]
    : ''
  const selectedTaskOwnerLabel = selectedTask ? getTaskOwnerLabel(selectedTask, rosterById) : ''
  const selectedTaskNeedsInputNote = selectedTask?.status === 'needs_input'
    ? selectedTask.notes[0] || 'Worker is waiting for input.'
    : null
  const selectedTaskCanSpawnWorker = selectedTaskBoardColumn === 'ready' && !selectedTask?.ownerAgentId
  const selectedTaskCanManageWorker = selectedTask?.status === 'in_progress' || selectedTask?.status === 'needs_input'
  const selectedTaskOwnerCliRunning = selectedTask?.ownerAgentId
    ? Boolean(agents[selectedTask.ownerAgentId]?.cliStartRequested)
    : false
  const activateView = (view: SwarmView) => {
    if (fixedView) return
    setActiveView(view)
  }

  const toggleAuto = () => {
    updateSwarmAutoState(workspaceId, (current) => {
      const enabled = !current.enabled
      return {
        enabled,
        pending: enabled ? current.pending : null,
      }
    })
  }

  const openAddMemberDialog = () => {
    const uncoveredRole = addableRoles.find((role) =>
      swarmState.tasks.some((task) => task.role === role && task.status !== 'done')
      && !roster.some((agent) => agent.role === role)
    )
    setAddMemberRole(uncoveredRole ?? 'developer')
    setActionMenuOpen(false)
    setAddMemberOpen(true)
  }

  const confirmAddMember = () => {
    const addedAgent = addSwarmMember(workspaceId, addMemberRole)
    if (!addedAgent) return

    startAgentTerminal(addedAgent.id, addedAgent.label)
    setSelectedAgentId(addedAgent.id)
    setAddMemberOpen(false)
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
    const existing = roster.find((agent) =>
      agent.role === role
      && runtimeAgentById[agent.id]?.status !== 'done'
      && !agents[agent.id]?.cliStartRequested
    )
      ?? roster.find((agent) => agent.role === role && runtimeAgentById[agent.id]?.status !== 'done')
    const agent = existing ?? addSwarmMember(workspaceId, role)
    if (!agent) return

    openSpawnDialog(agent.id)
  }

  const openReadySpawnDialogForRole = (role: SwarmRole) => {
    const existing = roster.find((agent) =>
      agent.role === role
      && runtimeAgentById[agent.id]?.status !== 'done'
      && !agents[agent.id]?.cliStartRequested
    )
    const agent = existing ?? addSwarmMember(workspaceId, role)
    if (!agent) return

    openSpawnDialog(agent.id)
  }

  const openReadyTaskWorker = (task: SwarmTask) => {
    if (task.ownerAgentId) {
      const agentId = task.ownerAgentId
      const agent = rosterById[agentId]
      const label = agent?.label ?? agentId

      if (agents[agentId]?.cliStartRequested) {
        openAgentTerminal(agentId)
        return
      }

      setSelectedAgentId(agentId)
      startAgentTerminal(agentId, label, agents[agentId]?.cli ?? 'codex', {
        freshSession: true,
        startupPrompt: buildWorkerRespawnStartupPrompt(
          agent?.role ?? task.role,
          agentId
        ),
      })
      return
    }

    openReadySpawnDialogForRole(task.role)
  }

  const loadPlanReader = async () => {
    if (!swarmState || !folderPath) {
      setPlanReader((current) => ({
        ...current,
        open: true,
        status: 'error',
        error: 'Choose a workspace folder before reading the swarm plan.',
      }))
      return
    }

    const swarmRootDirectory = getSwarmRootDirectoryPath(folderPath)
    const swarmDirectory = getSwarmDirectoryPath(folderPath, swarmName)
    const nextPlanFilePath = getSwarmPlanFilePath(folderPath, swarmName)
    setPlanReader((current) => ({
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

      setPlanReader((current) => ({
        ...current,
        open: true,
        status: 'ready',
        content,
        error: null,
      }))
    } catch (error) {
      setPlanReader((current) => ({
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
    let content = planReader.content
    if (!content) {
      try {
        content = await window.api.readfile(planFilePath)
      } catch {
        content = ''
      }
    }
    openFile(workspaceId, planFilePath, 'plan.md', content)
    focusOrAddComponentTab(workspaceId, 'editor', 'Editor')
    setPlanReader((current) => ({ ...current, open: false }))
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

  const requestPlanReviews = () => {
    if (!folderPath || specialistReviewAgents.length === 0) return

    specialistReviewAgents.forEach((agent) => {
      startAgentTerminal(agent.id, agent.label, agents[agent.id]?.cli ?? 'codex', {
        freshSession: true,
        startupPrompt: buildPlanReviewStartupPrompt(agent.role, agent.id),
      })
    })

    setSelectedAgentId(specialistReviewAgents.at(-1)?.id ?? null)
  }

  const addressPlanReviews = () => {
    if (!folderPath || !architectAgentId) return
    const label = rosterById[architectAgentId]?.label ?? 'Architect'

    startAgentTerminal(architectAgentId, label, agents[architectAgentId]?.cli ?? 'codex', {
      freshSession: true,
      startupPrompt: buildAddressPlanReviewsPrompt(),
    })
    setSelectedAgentId(architectAgentId)
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#08090b] text-[#ececee]">
      <div className="border-b border-[#1f2025] bg-[#0d0e11] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={autoEnabled}
              onClick={toggleAuto}
              className={`flex items-center gap-3 rounded-md border px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                autoEnabled
                  ? 'border-[#6ee7d8]/55 bg-[#6ee7d8]/14 text-[#d8fffb] hover:border-[#6ee7d8]/75 hover:bg-[#6ee7d8]/18'
                  : 'border-[#303139] bg-[#111216] text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
              }`}
            >
              <span
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  autoEnabled ? 'bg-[#6ee7d8]' : 'bg-[#303139]'
                }`}
                aria-hidden="true"
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
                    autoEnabled ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </span>
              <span>Auto</span>
            </button>
            {!fixedView ? (
              <div className="ml-1 flex flex-wrap items-center gap-1">
                {([
                  { id: 'project' as const, label: 'Project' },
                  { id: 'map' as const, label: 'Map' },
                  { id: 'task-graph' as const, label: 'Task Graph' },
                  { id: 'kanban' as const, label: 'Kanban' },
                ]).map((view) => (
                  <button
                    key={view.id}
                    onClick={() => activateView(view.id)}
                    className={`rounded px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                      effectiveView === view.id
                        ? 'text-[#ececee]'
                        : 'text-[#8a8a92] hover:bg-[#17181d] hover:text-[#ececee]'
                    }`}
                  >
                    {view.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {focusAgent ? (
              <button
                onClick={() => {
                  if (focusAgentIsLaunched) {
                    openAgentTerminal(focusAgent.agentId)
                  } else {
                    openSpawnDialog(focusAgent.agentId)
                  }
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                  needsInputAgent
                    ? 'bg-[#ffbf2f]/12 text-[#ffe0a3] hover:bg-[#ffbf2f]/18'
                    : 'bg-[#6ee7d8]/10 text-[#d8fffb] hover:bg-[#6ee7d8]/16'
                }`}
              >
                {focusAgentIsLaunched
                  ? `Focus ${focusAgentRoster?.label ?? focusAgent.agentId}`
                  : `Spawn ${focusAgentRoster?.label ?? focusAgent.agentId}`}
              </button>
            ) : null}
            {readyRoleLaunches.map(({ role, agent }) => {
              const duplicatesFocusRole = focusAgentRole === role
              const availableAgent = roster.find((candidate) =>
                candidate.role === role && !agents[candidate.id]?.cliStartRequested
              )
              const shouldSpawnAdditional = duplicatesFocusRole || Boolean(availableAgent)
              const isRunning = agent ? Boolean(agents[agent.id]?.cliStartRequested) : false
              const label = agent?.label ?? swarmRoleLabels[role]
              return (
                <button
                  key={role}
                  onClick={() => {
                    if (shouldSpawnAdditional) {
                      openReadySpawnDialogForRole(role)
                    } else {
                      openSpawnDialogForRole(role)
                    }
                  }}
                  className="rounded-md bg-[#6ee7d8]/10 px-3 py-1.5 text-sm font-semibold text-[#d8fffb] transition-colors hover:bg-[#6ee7d8]/16"
                >
                  {isRunning && !shouldSpawnAdditional ? `Focus ${label}` : `Spawn ${swarmRoleLabels[role]}`}
                </button>
              )
            })}
            {architectAgentId && showPlanningActions && readyRoleLaunches.length === 0 ? (
              <button
                onClick={() => openSpawnDialog(architectAgentId)}
                className="rounded-md bg-[#ffbf2f]/12 px-3 py-1.5 text-sm font-semibold text-[#ffe0a3] transition-colors hover:bg-[#ffbf2f]/16"
              >
                {agents[architectAgentId]?.cliStartRequested ? 'Focus Architect' : 'Spawn Architect'}
              </button>
            ) : null}
            {architectAgentId ? (
              <button
                onClick={openRecoveryDialog}
                className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#8a8a92] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Verify Progress
              </button>
            ) : null}
            <div className="relative">
              <button
                onClick={() => setActionMenuOpen((open) => !open)}
                className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#8a8a92] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                aria-haspopup="menu"
                aria-expanded={actionMenuOpen}
              >
                More
              </button>
              {actionMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+8px)] z-30 w-56 overflow-hidden rounded-lg border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                >
                  <button
                    role="menuitem"
                    onClick={openAddMemberDialog}
                    className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                  >
                    More Roles
                  </button>
                  {showPlanningActions ? (
                    <>
                      <button
                        role="menuitem"
                        onClick={() => {
                          setActionMenuOpen(false)
                          requestPlanReviews()
                        }}
                        disabled={!folderPath || specialistReviewAgents.length === 0}
                        className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[#d7d7dc]"
                      >
                        Request Plan Reviews
                      </button>
                      {architectAgentId ? (
                        <button
                          role="menuitem"
                          onClick={() => {
                            setActionMenuOpen(false)
                            addressPlanReviews()
                          }}
                          disabled={!folderPath}
                          className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[#d7d7dc]"
                        >
                          Address Feedback
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {allTasksDone ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-4 border-l-2 border-[#30d158] bg-[#30d158]/8 px-4 py-3">
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
              className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#d4ffdc] transition-colors hover:bg-[#30d158]/12"
            >
              View Run Summary
            </button>
          </div>
        ) : null}

      </div>

      {folderStatusBanner}

      {effectiveView === 'project' ? (
        <SwarmProjectView
          swarmState={swarmState}
          roster={roster}
          runtimeAgents={runtimeAgents}
          agents={agents}
          runPhase={runPhase}
          doneCount={doneCount}
          activeCount={activeCount}
          needsInputCount={needsInputCount}
          readyTasks={readyTasks}
          onSelectAgent={(agentId) => {
            if (agents[agentId]?.cliStartRequested) {
              openAgentTerminal(agentId)
            } else {
              openSpawnDialog(agentId)
            }
          }}
          onAddMember={openAddMemberDialog}
          onReadPlan={() => void loadPlanReader()}
        />
      ) : null}

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

      {effectiveView === 'task-graph' ? (
        <SwarmTaskGraphView
          swarmState={swarmState}
          rosterById={rosterById}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
        />
      ) : null}

      {effectiveView === 'kanban' ? (
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(5,minmax(260px,1fr))] overflow-auto bg-[#08090b]">
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
            className="flex min-h-0 min-w-0 flex-col border-r border-[#1f2025] bg-[#08090b] last:border-r-0"
          >
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f2025] bg-[#0d0e11] px-3">
              <div className="min-w-0 truncate text-sm font-semibold text-[#ececee]">{column.label}</div>
              <span className="shrink-0 text-[11px] font-bold text-[#5a5a63]">
                {column.cards.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {column.cards.map((task) => {
                const ownerAgent = task.ownerAgentId ? rosterById[task.ownerAgentId] : undefined
                const claimRole = task.ownerAgentId ? ownerAgent?.role ?? task.role : null
                const ownerLabel = task.ownerAgentId
                  ? ownerAgent?.label ?? task.ownerAgentId
                  : null
                const ownerCliRunning = task.ownerAgentId
                  ? Boolean(agents[task.ownerAgentId]?.cliStartRequested)
                  : false
                const boardColumn = getSwarmTaskBoardColumn(task, swarmState.tasks)
                const statusLabel = boardColumn === 'ready' ? 'Ready' : taskStateLabel[task.status]
                const dependencyLabel = task.dependsOn.length > 0
                  ? `${task.dependsOn.length} ${task.dependsOn.length === 1 ? 'dep' : 'deps'}`
                  : 'root'
                const attentionText = task.status === 'needs_input'
                  ? task.notes[0] || 'Worker is waiting for input.'
                  : task.status === 'done'
                    ? task.evidence.summary || 'Completed with no summary recorded.'
                    : null
                const showTaskAction = boardColumn === 'ready' || task.status === 'in_progress' || task.status === 'needs_input'
                const metadata = [
                  ownerLabel ?? 'Unassigned',
                  dependencyLabel,
                  `${task.acceptanceCriteria.length} checks`,
                ]
                const actionLabel = task.ownerAgentId
                  ? ownerCliRunning ? 'Focus' : 'Respawn'
                  : `Spawn ${swarmRoleLabels[task.role]}`
                return (
                  <article
                    key={task.id}
                    onClick={() => setSelectedTaskId(task.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedTaskId(task.id)
                      }
                    }}
                    className="group relative w-full cursor-pointer overflow-hidden rounded-md px-2.5 py-2.5 text-left text-[#9a9aa2] transition-colors hover:bg-[#111216] focus:outline-none focus:ring-1 focus:ring-[#303139]"
                  >
                    {claimRole || boardColumn === 'ready' || task.status === 'needs_input' ? (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-r-full"
                        style={{
                          backgroundColor: task.status === 'needs_input'
                            ? '#ffbf2f'
                            : boardColumn === 'ready'
                              ? '#30d158'
                              : swarmRoleAccent[claimRole ?? task.role],
                        }}
                      />
                    ) : null}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[#5a5a63]">
                          <span>{task.id}</span>
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{
                              backgroundColor: swarmRoleAccent[task.role],
                            }}
                          />
                          <span style={{ color: swarmRoleAccent[task.role] }}>
                            {swarmRoleLabels[task.role]}
                          </span>
                        </div>
                        <div className="mt-1 text-sm font-semibold leading-5 text-[#ececee]">{task.title}</div>
                      </div>
                      <span
                        className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.1em] ${
                          task.status === 'needs_input'
                            ? 'text-[#ffbf2f]'
                            : boardColumn === 'ready'
                              ? 'text-[#30d158]'
                              : task.status === 'in_progress'
                                ? 'text-[#ffd58a]'
                                : task.status === 'done'
                                  ? 'text-[#b9f7c8]'
                                  : 'text-[#5a5a63]'
                        }`}
                      >
                        {statusLabel}
                      </span>
                    </div>

                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-[#5a5a63]">
                      {metadata.map((item, index) => (
                        <React.Fragment key={item}>
                          {index > 0 ? <span className="shrink-0 text-[#3a3d49]">/</span> : null}
                          <span className="min-w-0 truncate">{item}</span>
                        </React.Fragment>
                      ))}
                    </div>

                    {attentionText ? (
                      <div className={`mt-2 line-clamp-2 border-l-2 pl-2 text-[11px] leading-5 ${
                        task.status === 'needs_input'
                          ? 'border-[#ffbf2f] text-[#ffe0a3]'
                          : task.status === 'done'
                            ? 'border-[#30d158] text-[#9a9aa2]'
                            : 'border-[#6ee7d8] text-[#bff7f1]'
                      }`}>
                        {attentionText}
                      </div>
                    ) : null}
                    {showTaskAction ? (
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            openReadyTaskWorker(task)
                          }}
                          className="rounded px-2 py-1 text-[11px] font-semibold text-[#8a8a92] opacity-0 transition-colors hover:bg-[#17181d] hover:text-[#ececee] group-hover:opacity-100 group-focus:opacity-100"
                        >
                          {actionLabel}
                        </button>
                      </div>
                    ) : null}
                  </article>
                )
              })}

              {column.cards.length === 0 ? (
                <div className="px-2 py-3 text-[12px] leading-5 text-[#5a5a63]">
                  {emptyKanbanColumnLabel(column.key)}
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
              <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                <MetaItem label="Tasks" value={`${swarmState.tasks.length} to check`} />
                <MetaItem label="Backup" value="state-timestamp.yaml" />
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

              <p className="border-l border-[#303139] pl-3 text-sm leading-6 text-[#9a9aa2]">
                No app-side recovery state is created. The Architect performs the audit in the terminal and updates the watched state file directly.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
              <button
                onClick={() => {
                  setCliPickerOpen(false)
                  setRecoveryDialog(null)
                }}
                className="rounded-md px-4 py-2 text-sm font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
              <button
                onClick={confirmRecoveryAudit}
                disabled={!folderPath || !architectAgentId}
                className="rounded-md bg-[#30d158] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#69e783] disabled:opacity-45 disabled:hover:bg-[#30d158]"
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
              <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                <MetaItem label="Role" value={swarmRoleLabels[spawnDialogAgent.role]} />
                <MetaItem label="Status" value={runtimeStatusLabel(spawnDialogRuntime?.status ?? 'idle')} />
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

              <p className="border-l border-[#303139] pl-3 text-sm leading-6 text-[#9a9aa2]">
                {cliOptions.find((option) => option.value === spawnDialog.cli)?.description}
                {spawnDialogIsRunning ? (
                  <span className="text-[#5a5a63]"> A terminal already exists, so this will focus it unless you changed the CLI.</span>
                ) : null}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
              <button
                onClick={() => {
                  setCliPickerOpen(false)
                  setSpawnDialog(null)
                }}
                className="rounded-md px-4 py-2 text-sm font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
              <button
                onClick={confirmSpawnDialog}
                className="rounded-md bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea]"
              >
                {spawnDialogIsRunning ? 'Open Terminal' : 'Spawn'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedTask && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[920px] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Task Detail
                </div>
                <h3 className="text-[20px] font-semibold leading-7 tracking-tight text-[#ececee]">
                  {selectedTask.title}
                </h3>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#5a5a63]">
                  <span className="font-mono">{selectedTask.id}</span>
                  <span>{swarmRoleLabels[selectedTask.role]}</span>
                  <span className="font-semibold text-[#d7d7dc]">{selectedTaskStatusLabel}</span>
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
              <div className="grid gap-x-6 gap-y-3 border-b border-[#1f2025] pb-5 md:grid-cols-4">
                <MetaItem label="Status" value={selectedTaskStatusLabel} />
                <MetaItem label="Owner" value={selectedTaskOwnerLabel} />
                <MetaItem label="Dependencies" value={selectedTask.dependsOn.join(', ') || 'None'} />
                <MetaItem
                  label={selectedTask.completedAt ? 'Completed' : 'Started'}
                  value={formatTimestamp(selectedTask.completedAt ?? selectedTask.startedAt)}
                />
              </div>

              {selectedTaskNeedsInputNote ? (
                <div className="border-l-2 border-[#ffbf2f] bg-[#ffbf2f]/8 px-4 py-3 text-sm text-[#ffe0a3]">
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#ffbf2f]">
                    Needs Input
                  </div>
                  <div className="mt-2 leading-6">
                    {selectedTaskNeedsInputNote}
                  </div>
                  <div className="mt-2 text-[12px] text-[#ffe0a3]/75">
                    Respond in the worker CLI to unblock this task.
                  </div>
                </div>
              ) : null}

              {selectedTask.ownerAgentId && selectedTaskCanManageWorker ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f2025] pb-5">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                      Worker CLI
                    </div>
                    <div className="mt-1 text-sm text-[#d7d7dc]">
                      {selectedTaskOwnerCliRunning
                        ? `Jump straight to ${rosterById[selectedTask.ownerAgentId]?.label ?? selectedTask.ownerAgentId} to continue or answer questions there.`
                        : `Respawn ${rosterById[selectedTask.ownerAgentId]?.label ?? selectedTask.ownerAgentId} to continue this assigned task.`}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      openReadyTaskWorker(selectedTask)
                      setSelectedTaskId(null)
                    }}
                    className="rounded-md border border-[#303139] bg-[#111216] px-4 py-2 text-sm font-semibold text-[#ececee] transition-colors hover:bg-[#17181d]"
                  >
                    {selectedTaskOwnerCliRunning ? 'Focus' : 'Respawn'}
                  </button>
                </div>
              ) : null}

              {selectedTaskCanSpawnWorker ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f2025] pb-5">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#6ee7d8]">
                      Ready To Claim
                    </div>
                    <div className="mt-1 text-sm text-[#d8fffb]">
                      Start a {swarmRoleLabels[selectedTask.role]} for this ready task.
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      openReadyTaskWorker(selectedTask)
                      setSelectedTaskId(null)
                    }}
                    className="rounded-md border border-[#6ee7d8]/50 bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea]"
                  >
                    Spawn {swarmRoleLabels[selectedTask.role]}
                  </button>
                </div>
              ) : null}

              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Description
                </div>
                <div className="text-[#d7d7dc]">
                  {selectedTask.description || 'No description recorded.'}
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
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
              </div>

              <SectionList title="Notes" items={selectedTask.notes} emptyLabel="No notes recorded." />

              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Evidence Summary
                </div>
                <div className="text-[#d7d7dc]">
                  {selectedTask.evidence.summary || 'No completion summary recorded yet.'}
                </div>
              </div>

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
            </div>
          </div>
        </div>
      )}

      {showRunSummary ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[980px] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
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
              <div className="grid gap-x-6 gap-y-3 border-b border-[#1f2025] pb-5 md:grid-cols-4">
                <MetaItem label="Tasks Done" value={`${runSummary.completedTasks}/${runSummary.totalTasks}`} />
                <MetaItem label="Files Touched" value={String(runSummary.touchedFiles.length)} />
                <MetaItem label="Commands" value={String(runSummary.commandsRan.length)} />
                <MetaItem label="Results" value={String(runSummary.results.length)} />
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

              <div className="border-l-2 border-[#ffbf2f] bg-[#ffbf2f]/8 px-4 py-3 text-sm text-[#ffe0a3]">
                Next step: manually test the uncommitted changes in the workspace before committing or reverting.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {addMemberOpen ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[760px] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
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
                className="rounded-md px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Close
              </button>
            </div>

            <div className="space-y-1 px-5 py-5">
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
                    aria-pressed={selected}
                    className={`w-full rounded-lg border-l-2 px-3 py-3 text-left transition-colors ${
                      selected
                        ? 'border-l-[#6ee7d8] bg-[#6ee7d8]/10 text-[#ececee]'
                        : 'border-l-transparent text-[#d7d7dc] hover:bg-[#17181d]'
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <span
                        className="hidden h-2.5 w-2.5 shrink-0 rounded-full sm:mt-1.5 sm:block"
                        style={{ backgroundColor: swarmRoleAccent[role] }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                          {swarmRoleLabels[role]}
                        </div>
                        <p className={`mt-1 text-[12px] leading-5 ${selected ? 'text-[#bff7f1]' : 'text-[#9a9aa2]'}`}>
                          {roleSummaries[role]}
                        </p>
                      </div>
                      <span className={`shrink-0 pt-0.5 text-right text-[11px] font-semibold uppercase tracking-[0.12em] ${
                        selected ? 'text-[#bff7f1]' : 'text-[#5a5a63]'
                      }`}>
                        {activeForRole} active / {openTasksForRole} open
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
              <button
                onClick={() => setAddMemberOpen(false)}
                className="rounded-md px-4 py-2 text-sm font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
              <button
                onClick={confirmAddMember}
                className="rounded-md bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea]"
              >
                Spawn {swarmRoleLabels[addMemberRole]}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {planReader.open ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Architect Plan
                </div>
                <h3 className="truncate text-[20px] font-semibold tracking-tight text-[#ececee]">
                  {planFilePath ?? 'swarm/plan.md'}
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() =>
                    setPlanReader((current) => ({
                      ...current,
                      mode: current.mode === 'preview' ? 'source' : 'preview',
                    }))
                  }
                  className="rounded-md px-3 py-2 text-sm text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                >
                  {planReader.mode === 'preview' ? 'Source' : 'Preview'}
                </button>
                <button
                  onClick={() => void loadPlanReader()}
                  className="rounded-md px-3 py-2 text-sm text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                >
                  Refresh
                </button>
                {architectAgentId ? (
                  <button
                    onClick={() => openAgentTerminal(architectAgentId)}
                    className="rounded-md px-3 py-2 text-sm text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                  >
                    Focus Architect
                  </button>
                ) : null}
                <button
                  onClick={() => setPlanReader((current) => ({ ...current, open: false }))}
                  className="rounded-md px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {planReader.status === 'loading' ? (
                <div className="px-1 py-2 text-sm text-[#9a9aa2]">
                  Loading plan...
                </div>
              ) : null}
              {planReader.status === 'error' ? (
                <div className="border-l border-[#ff1a3d]/60 pl-3 text-sm leading-6 text-[#ffb3bf]">
                  {planReader.error ?? 'Failed to load plan.'}
                </div>
              ) : null}
              {planReader.status === 'ready' && planReader.mode === 'preview' ? (
                <div className="mx-auto max-w-4xl">
                  {planReader.content
                    ? renderMarkdown(planReader.content)
                    : (
                      <div className="border-l border-[#303139] pl-3 text-sm leading-6 text-[#9a9aa2]">
                        No architect plan has been written yet.
                      </div>
                  )}
                </div>
              ) : null}
              {planReader.status === 'ready' && planReader.mode === 'source' ? (
                <pre className="min-h-[420px] overflow-x-auto rounded-lg bg-[#08090b] p-4 text-[13px] leading-6 text-[#d7d7dc]">
                  <code>{planReader.content}</code>
                </pre>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
              <div className="text-[12px] text-[#5a5a63]">
                This is a read-only view of the architect plan.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {planFilePath ? (
                  <button
                    onClick={() => void openPlanInEditor()}
                    className="rounded-md px-4 py-2 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                  >
                    Open in Editor
                  </button>
                ) : null}
                <button
                  onClick={() => setPlanReader((current) => ({ ...current, open: false }))}
                  className="rounded-md bg-[#ffbf2f] px-4 py-2 text-sm font-semibold text-[#191306] transition-colors hover:bg-[#ffd166]"
                >
                  Done
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

function SwarmProjectView({
  swarmState,
  roster,
  runtimeAgents,
  agents,
  runPhase,
  doneCount,
  activeCount,
  needsInputCount,
  readyTasks,
  onSelectAgent,
  onAddMember,
  onReadPlan,
}: {
  swarmState: SwarmState
  roster: RosterItem[]
  runtimeAgents: RuntimeAgentView[]
  agents: Record<string, AgentState>
  runPhase: string
  doneCount: number
  activeCount: number
  needsInputCount: number
  readyTasks: SwarmTask[]
  onSelectAgent: (agentId: string) => void
  onAddMember: () => void
  onReadPlan: () => void
}) {
  const [goalExpanded, setGoalExpanded] = useState(false)
  const fullGoal = formatSwarmGoal(swarmState.goal)
  const goalPreview = formatSwarmGoalPreview(swarmState.goal)
  const canExpandGoal = fullGoal !== goalPreview || fullGoal.length > 260
  const tasksByRole = useMemo(() => {
    const counts: Record<SwarmRole, { open: number; ready: number }> = {
      architect: { open: 0, ready: 0 },
      product: { open: 0, ready: 0 },
      developer: { open: 0, ready: 0 },
      frontend: { open: 0, ready: 0 },
      tester: { open: 0, ready: 0 },
      security: { open: 0, ready: 0 },
    }

    swarmState.tasks.forEach((task) => {
      if (task.status !== 'done') counts[task.role].open += 1
      if (readyTasks.some((readyTask) => readyTask.id === task.id)) counts[task.role].ready += 1
    })

    return counts
  }, [readyTasks, swarmState.tasks])

  const currentTaskByAgentId = useMemo(() => {
    const tasksById = Object.fromEntries(swarmState.tasks.map((task) => [task.id, task]))
    return Object.fromEntries(
      runtimeAgents.map((agent) => [
        agent.agentId,
        agent.currentTaskId ? tasksById[agent.currentTaskId] ?? null : null,
      ])
    )
  }, [runtimeAgents, swarmState.tasks])

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[#08090b] p-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="bg-[#0d0e11] px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Project Brief
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold text-[#ececee]">
                {swarmState.name}
              </h2>
            </div>
            <button
              onClick={onReadPlan}
              className="rounded-md border border-[#24252b] bg-[#111216] px-3 py-1.5 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
            >
              Read Plan
            </button>
          </div>

          <div className="mt-4 space-y-5">
            <div className="grid gap-x-6 gap-y-3 border-y border-[#1f2025] py-4 sm:grid-cols-4">
              <MetaItem label="Phase" value={runPhase} />
              <MetaItem label="Tasks" value={String(swarmState.tasks.length)} />
              <MetaItem label="Done" value={`${doneCount}/${swarmState.tasks.length}`} />
              <MetaItem label="Active" value={`${activeCount} running, ${needsInputCount} waiting`} />
            </div>

            <button
              type="button"
              onClick={() => {
                if (canExpandGoal) setGoalExpanded((current) => !current)
              }}
              aria-expanded={goalExpanded}
              className={`block w-full border-l-2 border-[#303139] pl-3 text-left transition-colors ${
                canExpandGoal ? 'hover:border-[#6ee7d8]' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Goal
                </div>
                {canExpandGoal ? (
                  <svg
                    className={`h-4 w-4 shrink-0 text-[#5a5a63] transition-transform ${goalExpanded ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </div>
              <div className={`mt-2 whitespace-pre-wrap text-sm leading-6 text-[#d7d7dc] ${
                goalExpanded ? 'max-h-72 overflow-y-auto pr-2' : 'line-clamp-4'
              }`}>
                {goalExpanded ? fullGoal : goalPreview}
              </div>
            </button>
          </div>
        </section>

        <section className="bg-[#0d0e11] px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Team
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                Specialist Roster
              </div>
            </div>
            <button
              onClick={onAddMember}
              className="rounded-md border border-[#24252b] bg-[#111216] px-3 py-1.5 text-sm font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
            >
              More Roles
            </button>
          </div>

          <div className="mt-4 divide-y divide-[#1f2025] border-y border-[#1f2025]">
            {roster.map((agent) => {
              const runtime = runtimeAgents.find((candidate) => candidate.agentId === agent.id)
              const isLaunched = Boolean(agents[agent.id]?.cliStartRequested)
              const counts = tasksByRole[agent.role]
              const currentTask = currentTaskByAgentId[agent.id]
              const activeTaskLabel = currentTask ? `${currentTask.id}: ${currentTask.title}` : 'No active task'

              return (
                <div
                  key={agent.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
                >
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-full border bg-[#111216] text-[11px] font-bold text-[#ececee]"
                    style={{
                      borderColor: swarmRoleAccent[agent.role],
                    }}
                  >
                    {agent.label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold leading-5 text-[#ececee]">{agent.label}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[#5a5a63]">
                      <span>{runtimeStatusLabel(runtime?.status ?? 'idle')}</span>
                      <span>{counts.open} open</span>
                      <span>{counts.ready} ready</span>
                    </div>
                    <div className="mt-1 truncate text-[12px] text-[#9a9aa2]">
                      {activeTaskLabel}
                    </div>
                  </div>
                  <button
                    onClick={() => onSelectAgent(agent.id)}
                    className={`col-span-2 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors sm:col-span-1 ${
                      isLaunched
                        ? 'text-[#d4ffdc] hover:bg-[#30d158]/12'
                        : 'text-[#d8fffb] hover:bg-[#6ee7d8]/12'
                    }`}
                  >
                    {isLaunched ? 'Focus CLI' : `Spawn ${swarmRoleLabels[agent.role]}`}
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
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
  const mapCanvasRef = useRef<HTMLDivElement | null>(null)

  const updateMapCursor = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = mapCanvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--swarm-cursor-x', `${event.clientX - rect.left}px`)
    el.style.setProperty('--swarm-cursor-y', `${event.clientY - rect.top}px`)
    el.style.setProperty('--swarm-cursor-opacity', '1')
  }

  const clearMapCursor = () => {
    mapCanvasRef.current?.style.setProperty('--swarm-cursor-opacity', '0')
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-[#08090b] lg:grid-cols-[minmax(0,1fr)_340px]">
      <div
        ref={mapCanvasRef}
        onPointerEnter={updateMapCursor}
        onPointerMove={updateMapCursor}
        onPointerLeave={clearMapCursor}
        className="relative min-h-[460px] overflow-hidden"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 1px, transparent 1px)',
          backgroundColor: '#08090b',
          backgroundSize: '24px 24px',
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 transition-opacity duration-150"
          style={{
            backgroundImage:
              'radial-gradient(circle, rgba(255,255,255,0.38) 0, rgba(255,255,255,0.38) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
            maskImage:
              'radial-gradient(circle at var(--swarm-cursor-x, 50%) var(--swarm-cursor-y, 50%), black 0, rgba(0,0,0,0.65) 18px, transparent 42px)',
            opacity: 'var(--swarm-cursor-opacity, 0)',
            WebkitMaskImage:
              'radial-gradient(circle at var(--swarm-cursor-x, 50%) var(--swarm-cursor-y, 50%), black 0, rgba(0,0,0,0.65) 18px, transparent 42px)',
          }}
        />
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
              className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center transition-transform hover:scale-[1.02] ${
                selected ? 'z-10 scale-[1.03]' : 'z-0'
              }`}
              style={{ left: `${node.x}%`, top: `${node.y}%` }}
            >
              <span
                className="relative flex h-16 w-16 items-center justify-center rounded-full border bg-[#111216] text-base font-semibold text-[#ececee]"
                style={{
                  borderColor: selected ? swarmRoleAccent[node.agent.role] : '#303139',
                  boxShadow: selected ? `0 0 0 3px ${hexToRgba(swarmRoleAccent[node.agent.role], 0.16)}` : undefined,
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
                <span className="max-w-[180px] truncate text-[10px] text-[#9a9aa2]">
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
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <MetaItem label="Phase" value={runPhase} />
            <MetaItem label="Board" value={`${swarmState.tasks.length} tasks`} />
            <MetaItem label="Tasks" value={`${doneCount}/${swarmState.tasks.length} done`} />
            <MetaItem label="Agents" value={`${activeCount} run, ${needsInputCount} wait`} />
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
                }}
              >
                {selectedAgent.label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold text-[#ececee]">{selectedAgent.label}</div>
                <div className="mt-1 text-sm text-[#9a9aa2]">{swarmRoleLabels[selectedAgent.role]}</div>
              </div>
            </div>

            <MetaItem label="Status" value={runtimeStatusLabel(selectedRuntime?.status ?? 'idle')} />
            <MetaItem label="Current Task" value={selectedTask ? `${selectedTask.id} - ${selectedTask.title}` : 'No active task'} />

            {selectedAgent.role === 'product' ? (
              <div className="border-l border-pink-300/35 pl-3 text-sm leading-6 text-pink-100">
                Product guides market fit, competitor context, audience needs, workflow risk, and prioritization before the plan hardens.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-4 border-l border-[#303139] pl-3 text-sm leading-6 text-[#5a5a63]">
            Select a specialist on the map.
          </div>
        )}
      </aside>
    </div>
  )
}

function SwarmTaskGraphView({
  swarmState,
  rosterById,
  selectedTaskId,
  onSelectTask,
}: {
  swarmState: SwarmState
  rosterById: Record<string, RosterItem | undefined>
  selectedTaskId: string | null
  onSelectTask: (taskId: string) => void
}) {
  const graph = useMemo(() => buildTaskGraphLayout(swarmState.tasks), [swarmState.tasks])
  const focusTaskId = useMemo(() => getTaskGraphFocusTaskId(swarmState.tasks), [swarmState.tasks])
  const displayTaskId = selectedTaskId ?? focusTaskId
  const displayTask = displayTaskId
    ? swarmState.tasks.find((task) => task.id === displayTaskId) ?? null
    : null
  const graphCanvasRef = useRef<HTMLDivElement | null>(null)
  const graphScrollRef = useRef<HTMLDivElement | null>(null)
  const lastCenteredKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const scrollEl = graphScrollRef.current
    const focusNode = focusTaskId ? graph.nodesById[focusTaskId] : null
    if (!scrollEl || !focusNode) return

    const centerKey = `${focusTaskId}:${graph.canvasWidth}:${graph.canvasHeight}`
    if (lastCenteredKeyRef.current === centerKey) return
    lastCenteredKeyRef.current = centerKey

    const frame = window.requestAnimationFrame(() => {
      scrollEl.scrollTo({
        left: Math.max(0, focusNode.x - scrollEl.clientWidth / 2),
        top: Math.max(0, focusNode.y - scrollEl.clientHeight / 2),
        behavior: 'smooth',
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [focusTaskId, graph])

  const updateGraphCursor = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = graphCanvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--swarm-cursor-x', `${event.clientX - rect.left}px`)
    el.style.setProperty('--swarm-cursor-y', `${event.clientY - rect.top}px`)
    el.style.setProperty('--swarm-cursor-opacity', '1')
  }

  const clearGraphCursor = () => {
    graphCanvasRef.current?.style.setProperty('--swarm-cursor-opacity', '0')
  }

  const readyCount = swarmState.tasks.filter(
    (task) => getSwarmTaskBoardColumn(task, swarmState.tasks) === 'ready'
  ).length
  const blockedCount = swarmState.tasks.filter(
    (task) => getSwarmTaskBoardColumn(task, swarmState.tasks) === 'todo' && task.dependsOn.length > 0
  ).length
  const inProgressCount = swarmState.tasks.filter((task) => task.status === 'in_progress').length
  const terminalCount = graph.terminalTaskIds.length

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-[#08090b] lg:grid-cols-[minmax(0,1fr)_360px]">
      <div
        ref={graphScrollRef}
        onPointerEnter={updateGraphCursor}
        onPointerMove={updateGraphCursor}
        onPointerLeave={clearGraphCursor}
        className="min-h-[460px] overflow-auto"
      >
        <div
          ref={graphCanvasRef}
          className="relative"
          style={{
            width: graph.canvasWidth,
            height: graph.canvasHeight,
            backgroundImage:
              'radial-gradient(circle, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 1px, transparent 1px)',
            backgroundColor: '#08090b',
            backgroundSize: '24px 24px',
          }}
        >
          <div
            className="pointer-events-none absolute inset-0 transition-opacity duration-150"
            style={{
              backgroundImage:
                'radial-gradient(circle, rgba(255,255,255,0.38) 0, rgba(255,255,255,0.38) 1px, transparent 1px)',
              backgroundSize: '24px 24px',
              maskImage:
                'radial-gradient(circle at var(--swarm-cursor-x, 50%) var(--swarm-cursor-y, 50%), black 0, rgba(0,0,0,0.65) 18px, transparent 42px)',
              opacity: 'var(--swarm-cursor-opacity, 0)',
              WebkitMaskImage:
                'radial-gradient(circle at var(--swarm-cursor-x, 50%) var(--swarm-cursor-y, 50%), black 0, rgba(0,0,0,0.65) 18px, transparent 42px)',
            }}
          />

          {swarmState.tasks.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              <div className="max-w-xl">
                <div className="text-sm font-semibold text-[#ececee]">Waiting for the architect plan</div>
                <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">
                  The dependency graph will appear as tasks are added through the swarm tool.
                </p>
              </div>
            </div>
          ) : null}

          <svg
            className="pointer-events-none absolute inset-0"
            width={graph.canvasWidth}
            height={graph.canvasHeight}
            viewBox={`0 0 ${graph.canvasWidth} ${graph.canvasHeight}`}
          >
            {graph.edges.map((edge) => {
              const from = graph.nodesById[edge.fromId]
              const to = graph.nodesById[edge.toId]
              if (!from || !to) return null
              return (
                <path
                  key={edge.id}
                  d={taskGraphEdgePath(from, to)}
                  fill="none"
                  stroke={edge.color}
                  strokeWidth={edge.weight}
                  strokeDasharray={edge.dashed ? '7 8' : undefined}
                  opacity={edge.opacity}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )
            })}
            {graph.nodes.map((node) => (
              <rect
                key={`${node.id}:line-blocker`}
                x={node.x - node.width / 2 - 8}
                y={node.y - node.height / 2 - 8}
                width={node.width + 16}
                height={node.height + 16}
                rx="14"
                fill="#08090b"
              />
            ))}
          </svg>

          {graph.nodes.map((node) => {
            if (node.type === 'end') {
              return (
                <div
                  key={node.id}
                  className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center overflow-hidden rounded-lg border border-[#303139] bg-[#111216] px-5 py-4 text-center"
                  style={{
                    left: node.x,
                    top: node.y,
                    width: node.width,
                    minHeight: node.height,
                  }}
                >
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#30d158]">
                    End Product
                  </div>
                  <div className="mt-2 line-clamp-3 text-sm font-semibold leading-5 text-[#d4ffdc]">
                    {formatSwarmGoalPreview(swarmState.goal)}
                  </div>
                  <div className="mt-3 text-[10px] uppercase tracking-[0.12em] text-[#9a9aa2]">
                    {terminalCount} final {terminalCount === 1 ? 'chain' : 'chains'}
                  </div>
                </div>
              )
            }

            const task = node.task
            const ownerAgent = task.ownerAgentId ? rosterById[task.ownerAgentId] : undefined
            const ownerRole = ownerAgent?.role ?? (task.ownerAgentId ? task.role : null)
            const ownerLabel = task.ownerAgentId ? ownerAgent?.label ?? task.ownerAgentId : null
            const isFocused = task.id === focusTaskId
            const isSelected = task.id === selectedTaskId
            const boardColumn = getSwarmTaskBoardColumn(task, swarmState.tasks)
            const dependencyLabel = task.dependsOn.length > 0
              ? `${task.dependsOn.length} ${task.dependsOn.length === 1 ? 'dep' : 'deps'}`
              : 'root'

            return (
              <button
                key={node.id}
                onClick={() => onSelectTask(task.id)}
                className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border p-3 text-left transition-transform hover:scale-[1.01] ${
                  isSelected || isFocused ? 'z-10' : 'z-0'
                }`}
                style={{
                  ...taskGraphNodeStyle(task, ownerRole, isFocused, isSelected),
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  minHeight: node.height,
                }}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-3 left-0 w-1 rounded-r-full"
                  style={{
                    backgroundColor: swarmRoleAccent[task.role],
                  }}
                />
                <div className="flex items-start justify-between gap-3 pl-2">
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-sm font-semibold leading-5 text-[#ececee]">{task.title}</div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[#5a5a63]">
                      <span>{task.id}</span>
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: swarmRoleAccent[task.role],
                        }}
                      />
                      <span className="min-w-0 truncate" style={{ color: swarmRoleAccent[task.role] }}>
                        {swarmRoleLabels[task.role]}
                      </span>
                    </div>
                  </div>
                  <span
                    className={`max-w-[92px] shrink-0 truncate rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${taskGraphStatusTone(task.status, boardColumn)}`}
                  >
                    {boardColumn === 'ready' ? 'Ready' : taskStateLabel[task.status]}
                  </span>
                </div>

                <p className="mt-3 line-clamp-2 pl-2 text-[12px] leading-5 text-[#9a9aa2]">
                  {task.description || 'No description recorded.'}
                </p>

                <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 pl-2 text-[10px] uppercase tracking-[0.12em] text-[#5a5a63]">
                  <span>
                    {dependencyLabel}
                  </span>
                  <span className="text-[#3a3d49]">/</span>
                  <span>
                    {task.acceptanceCriteria.length} checks
                  </span>
                  {ownerLabel && ownerRole ? (
                    <>
                      <span className="text-[#3a3d49]">/</span>
                      <span className="max-w-full truncate" style={{ color: swarmRoleAccent[ownerRole] }}>
                        {ownerLabel}
                      </span>
                    </>
                  ) : null}
                </div>
              </button>
            )
          })}
        </div>
      </div>
      <aside className="border-t border-[#1f2025] bg-[#0d0e11] p-4 lg:border-l lg:border-t-0">
        <div className="mb-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">Task Graph</div>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <MetaItem label="Tasks" value={String(swarmState.tasks.length)} />
            <MetaItem label="Ready" value={String(readyCount)} />
            <MetaItem label="Active" value={String(inProgressCount)} />
            <MetaItem label="Blocked" value={String(blockedCount)} />
          </div>
        </div>

        {(graph.hasCycle || graph.missingDependencyCount > 0) ? (
          <div className="mb-5 border-l border-[#ffbf2f]/60 pl-3 text-sm leading-6 text-[#ffe0a3]">
            {graph.hasCycle ? 'A dependency cycle was detected. ' : ''}
            {graph.missingDependencyCount > 0
              ? `${graph.missingDependencyCount} dependency ${graph.missingDependencyCount === 1 ? 'reference is' : 'references are'} missing.`
              : ''}
          </div>
        ) : null}

        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
          {selectedTaskId ? 'Selected Task' : 'Current Focus'}
        </div>
        {displayTask ? (
          <div className="mt-4 space-y-4">
            <div className="border-l pl-3" style={taskCardStyle(displayTask.role)}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-lg font-semibold text-[#ececee]">{displayTask.title}</div>
                  <div className="mt-1 text-sm text-[#9a9aa2]">
                    {displayTask.id} - {swarmRoleLabels[displayTask.role]}
                  </div>
                </div>
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{
                    backgroundColor: swarmRoleAccent[displayTask.role],
                  }}
                />
              </div>
            </div>

            <MetaItem
              label="Status"
              value={getSwarmTaskBoardColumn(displayTask, swarmState.tasks) === 'ready'
                ? 'Ready'
                : taskStateLabel[displayTask.status]}
            />
            <MetaItem
              label="Owner"
              value={getTaskOwnerLabel(displayTask, rosterById)}
            />
            <MetaItem
              label="Dependencies"
              value={displayTask.dependsOn.join(', ') || 'None'}
            />
            <button
              onClick={() => onSelectTask(displayTask.id)}
              className="w-full rounded-md bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea]"
            >
              Open Task Details
            </button>
          </div>
        ) : (
          <div className="mt-4 border-l border-[#303139] pl-3 text-sm leading-6 text-[#5a5a63]">
            No tasks have been planned yet.
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

type TaskGraphLayoutNode =
  | {
      id: string
      type: 'task'
      task: SwarmTask
      x: number
      y: number
      width: number
      height: number
    }
  | {
      id: string
      type: 'end'
      x: number
      y: number
      width: number
      height: number
    }

type TaskGraphLayoutEdge = {
  id: string
  fromId: string
  toId: string
  color: string
  opacity: number
  weight: number
  dashed: boolean
}

type TaskGraphLayout = {
  nodes: TaskGraphLayoutNode[]
  nodesById: Record<string, TaskGraphLayoutNode>
  edges: TaskGraphLayoutEdge[]
  canvasWidth: number
  canvasHeight: number
  terminalTaskIds: string[]
  hasCycle: boolean
  missingDependencyCount: number
}

function buildTaskGraphLayout(tasks: SwarmTask[]): TaskGraphLayout {
  const nodeWidth = 272
  const nodeHeight = 154
  const endNodeWidth = 252
  const endNodeHeight = 154
  const levelGap = 420
  const rowGap = 236
  const paddingX = 220
  const paddingY = 132
  const minCanvasWidth = 1180
  const minCanvasHeight = 720

  if (tasks.length === 0) {
    return {
      nodes: [],
      nodesById: {},
      edges: [],
      canvasWidth: minCanvasWidth,
      canvasHeight: minCanvasHeight,
      terminalTaskIds: [],
      hasCycle: false,
      missingDependencyCount: 0,
    }
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const validDepsByTask = new Map<string, string[]>()
  const dependentsByTask = new Map<string, string[]>()
  const indegreeByTask = new Map<string, number>()
  let missingDependencyCount = 0

  tasks.forEach((task) => {
    validDepsByTask.set(task.id, [])
    dependentsByTask.set(task.id, [])
    indegreeByTask.set(task.id, 0)
  })

  tasks.forEach((task) => {
    const uniqueDeps = Array.from(new Set(task.dependsOn))
    uniqueDeps.forEach((depId) => {
      if (depId === task.id || !taskById.has(depId)) {
        missingDependencyCount += 1
        return
      }

      validDepsByTask.get(task.id)?.push(depId)
      dependentsByTask.get(depId)?.push(task.id)
      indegreeByTask.set(task.id, (indegreeByTask.get(task.id) ?? 0) + 1)
    })
  })

  const levelByTask = new Map<string, number>()
  const queue = tasks
    .filter((task) => (indegreeByTask.get(task.id) ?? 0) === 0)
    .map((task) => task.id)
  const visited = new Set<string>()

  queue.forEach((taskId) => levelByTask.set(taskId, 0))

  while (queue.length > 0) {
    const taskId = queue.shift()!
    visited.add(taskId)
    const currentLevel = levelByTask.get(taskId) ?? 0

    dependentsByTask.get(taskId)?.forEach((dependentId) => {
      levelByTask.set(dependentId, Math.max(levelByTask.get(dependentId) ?? 0, currentLevel + 1))
      const nextIndegree = (indegreeByTask.get(dependentId) ?? 0) - 1
      indegreeByTask.set(dependentId, nextIndegree)
      if (nextIndegree === 0) queue.push(dependentId)
    })
  }

  const hasCycle = visited.size < tasks.length
  if (hasCycle) {
    const fallbackStart = Math.max(0, ...Array.from(levelByTask.values())) + 1
    tasks.forEach((task, index) => {
      if (visited.has(task.id)) return
      const dependencyLevels = (validDepsByTask.get(task.id) ?? [])
        .map((depId) => levelByTask.get(depId))
        .filter((level): level is number => typeof level === 'number')
      const nextLevel = dependencyLevels.length > 0
        ? Math.max(...dependencyLevels) + 1
        : fallbackStart + Math.floor(index / 3)
      levelByTask.set(task.id, nextLevel)
    })
  }

  const groups = new Map<number, SwarmTask[]>()
  tasks.forEach((task) => {
    const level = levelByTask.get(task.id) ?? 0
    const group = groups.get(level) ?? []
    group.push(task)
    groups.set(level, group)
  })

  const maxTaskLevel = Math.max(0, ...Array.from(groups.keys()))
  const endLevel = maxTaskLevel + 1
  const maxRows = Math.max(1, ...Array.from(groups.values()).map((group) => group.length))
  const canvasHeight = Math.max(minCanvasHeight, paddingY * 2 + nodeHeight + (maxRows - 1) * rowGap)
  const canvasWidth = Math.max(minCanvasWidth, paddingX * 2 + endLevel * levelGap + endNodeWidth)
  const nodes: TaskGraphLayoutNode[] = []

  Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .forEach(([level, group]) => {
      const columnTop = canvasHeight / 2 - ((group.length - 1) * rowGap) / 2
      group.forEach((task, index) => {
        nodes.push({
          id: task.id,
          type: 'task',
          task,
          x: paddingX + level * levelGap,
          y: columnTop + index * rowGap,
          width: nodeWidth,
          height: nodeHeight,
        })
      })
    })

  const endNode: TaskGraphLayoutNode = {
    id: 'end-product',
    type: 'end',
    x: paddingX + endLevel * levelGap,
    y: canvasHeight / 2,
    width: endNodeWidth,
    height: endNodeHeight,
  }
  nodes.push(endNode)

  const terminalTaskIds = tasks
    .filter((task) => (dependentsByTask.get(task.id) ?? []).length === 0)
    .map((task) => task.id)
  const fallbackTerminalTaskIds = terminalTaskIds.length > 0
    ? terminalTaskIds
    : tasks.filter((task) => (levelByTask.get(task.id) ?? 0) === maxTaskLevel).map((task) => task.id)

  const edges: TaskGraphLayoutEdge[] = []
  tasks.forEach((task) => {
    ;(validDepsByTask.get(task.id) ?? []).forEach((depId) => {
      const dependency = taskById.get(depId)
      if (!dependency) return
      edges.push({
        id: `${depId}->${task.id}`,
        fromId: depId,
        toId: task.id,
        ...taskGraphEdgeStyle(dependency, task),
      })
    })
  })

  fallbackTerminalTaskIds.forEach((taskId) => {
    const task = taskById.get(taskId)
    if (!task) return
    edges.push({
      id: `${taskId}->end-product`,
      fromId: taskId,
      toId: 'end-product',
      ...taskGraphEndEdgeStyle(task),
    })
  })

  const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]))

  return {
    nodes,
    nodesById,
    edges,
    canvasWidth,
    canvasHeight,
    terminalTaskIds: fallbackTerminalTaskIds,
    hasCycle,
    missingDependencyCount,
  }
}

function getTaskGraphFocusTaskId(tasks: SwarmTask[]): string | null {
  const newestBy = (candidates: SwarmTask[], field: 'startedAt' | 'completedAt') =>
    candidates
      .map((task, index) => ({ task, index }))
      .sort((a, b) => {
        const timeDelta = timestampMs(b.task[field]) - timestampMs(a.task[field])
        return timeDelta !== 0 ? timeDelta : b.index - a.index
      })[0]?.task.id ?? null

  return (
    newestBy(tasks.filter((task) => task.status === 'in_progress'), 'startedAt')
    ?? newestBy(tasks.filter((task) => task.status === 'needs_input'), 'startedAt')
    ?? newestBy(tasks.filter((task) => task.status === 'done'), 'completedAt')
    ?? tasks.find((task) => getSwarmTaskBoardColumn(task, tasks) === 'ready')?.id
    ?? tasks[0]?.id
    ?? null
  )
}

function timestampMs(value: string | null): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function taskGraphEdgePath(from: TaskGraphLayoutNode, to: TaskGraphLayoutNode): string {
  const startX = from.x + from.width / 2
  const startY = from.y
  const endX = to.x - to.width / 2
  const endY = to.y
  const horizontalGap = endX - startX

  if (horizontalGap < 120) {
    const curve = Math.max(72, horizontalGap * 0.42)
    return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`
  }

  if (Math.abs(endY - startY) < 2) {
    return `M ${startX} ${startY} H ${endX}`
  }

  const gutterX = startX + horizontalGap / 2
  const direction = endY > startY ? 1 : -1
  const radius = Math.min(22, Math.abs(endY - startY) / 2, Math.abs(gutterX - startX) / 2, Math.abs(endX - gutterX) / 2)

  return [
    `M ${startX} ${startY}`,
    `H ${gutterX - radius}`,
    `Q ${gutterX} ${startY} ${gutterX} ${startY + radius * direction}`,
    `V ${endY - radius * direction}`,
    `Q ${gutterX} ${endY} ${gutterX + radius} ${endY}`,
    `H ${endX}`,
  ].join(' ')
}

function taskGraphEdgeStyle(
  dependency: SwarmTask,
  dependent: SwarmTask
): Omit<TaskGraphLayoutEdge, 'id' | 'fromId' | 'toId'> {
  const dependencyDone = dependency.status === 'done'
  const active = dependent.status === 'in_progress' || dependent.status === 'needs_input'
  const color = active
    ? swarmRoleAccent[dependent.role]
    : dependencyDone
      ? '#30d158'
      : swarmRoleAccent[dependency.role]

  return {
    color,
    opacity: active ? 0.68 : dependencyDone ? 0.48 : 0.3,
    weight: active ? 2.2 : 1.6,
    dashed: false,
  }
}

function taskGraphEndEdgeStyle(
  task: SwarmTask
): Omit<TaskGraphLayoutEdge, 'id' | 'fromId' | 'toId'> {
  return {
    color: task.status === 'done' ? '#30d158' : swarmRoleAccent[task.role],
    opacity: task.status === 'done' ? 0.58 : 0.32,
    weight: task.status === 'done' ? 2 : 1.5,
    dashed: false,
  }
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

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#5a5a63]">{label}</div>
      <div className="mt-1 font-medium text-[#ececee] [overflow-wrap:anywhere]">{value}</div>
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
        <ul className="space-y-1.5 text-[#d7d7dc]">
          {items.map((item) => (
            <li key={item} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span className="mt-[0.65rem] h-1 w-1 rounded-full bg-[#5a5a63]" aria-hidden="true" />
              <span className="[overflow-wrap:anywhere]">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[12px] text-[#5a5a63]">
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

function taskCardStyle(claimRole: SwarmRole | null): React.CSSProperties | undefined {
  if (!claimRole) return undefined

  const accent = swarmRoleAccent[claimRole]
  return {
    borderColor: hexToRgba(accent, 0.72),
  }
}

function emptyKanbanColumnLabel(column: SwarmTaskBoardColumn): string {
  switch (column) {
    case 'ready':
      return 'No ready work. Waiting on dependencies or active workers.'
    case 'in_progress':
      return 'No workers are actively claiming tasks.'
    case 'needs_input':
      return 'No blocked tasks or worker questions.'
    case 'done':
      return 'Completed work will collect here.'
    default:
      return 'Planned tasks that are waiting on dependencies appear here.'
  }
}

function taskGraphNodeStyle(
  task: SwarmTask,
  ownerRole: SwarmRole | null,
  focused: boolean,
  selected: boolean
): React.CSSProperties {
  const roleAccent = swarmRoleAccent[ownerRole ?? task.role]
  const statusAccent =
    task.status === 'done'
      ? '#30d158'
      : task.status === 'needs_input'
        ? '#ffbf2f'
        : roleAccent

  return {
    borderColor: selected || focused ? hexToRgba(statusAccent, 0.82) : '#303139',
    backgroundColor: '#111216',
    boxShadow: selected ? `0 0 0 3px ${hexToRgba(statusAccent, 0.14)}` : undefined,
  }
}

function taskGraphStatusTone(taskStatus: SwarmTaskStatus, boardColumn: SwarmTaskBoardColumn): string {
  if (boardColumn === 'ready') return 'text-[#b9f7c8]'

  switch (taskStatus) {
    case 'done':
      return 'text-[#d4ffdc]'
    case 'needs_input':
      return 'text-[#ffe0a3]'
    case 'in_progress':
      return 'text-[#ffd58a]'
    default:
      return 'text-[#9a9aa2]'
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const red = parseInt(value.slice(0, 2), 16)
  const green = parseInt(value.slice(2, 4), 16)
  const blue = parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
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

  return task.status === 'done' ? swarmRoleLabels[task.role] : 'No active worker'
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
    'Fetch the canonical recovery instructions from the Python tool.',
    'Run `swarm recover` now.',
  ].join('\n')
}

function buildPlanReviewStartupPrompt(role: SwarmRole, agentId: string): string {
  return [
    'Fetch the canonical plan review instructions from the Python tool.',
    `Run \`swarm plan start-review --role ${role} --id ${agentId}\` now.`,
  ].join('\n')
}

function buildAddressPlanReviewsPrompt(): string {
  return [
    'Fetch the canonical plan review feedback instructions from the Python tool.',
    'Run `swarm plan address-reviews --actor architect` now.',
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
