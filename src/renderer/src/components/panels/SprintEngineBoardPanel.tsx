import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import type {
  AgentCli,
  AgentExecution,
  AgentState,
  SwarmArtifact,
  SwarmCliPermissionPreset,
  SwarmRole,
  SwarmState,
  SwarmTask,
  SwarmTaskBoardColumn,
  SwarmTaskFeedback,
  SwarmTaskFeedbackFinding,
  SwarmTaskFeedbackIssue,
  SwarmTaskStatus,
  Workspace,
} from '../../types/workspace'
import { SwarmRoleIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import {
  buildSwarmAgentRosterForState,
  getSwarmArtifactAutoApprovalEligibility,
  getReviewableSwarmArtifacts,
  getSwarmArtifactDependencyBlockers,
  getSwarmArtifactsByTaskId,
  getSwarmTaskBoardColumn,
  swarmRoleAccent,
  swarmArtifactKindLabels,
  swarmArtifactStatusLabels,
  swarmRoleLabels,
} from '../../utils/sprintengine'
import { renderMarkdown } from '../../utils/markdown'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../utils/agentPrompt'
import {
  getSwarmPlanFilePath,
  getSwarmRootDirectoryPath,
  parseSwarmStateFile,
} from '../../utils/sprintengineStateFile'
import { focusOrAddAgentTab, focusOrAddFileTab } from '../../utils/modelRegistry'
import { publishDiagnostic } from '../../utils/diagnostics'
import { sendArtifactApprovalToTerminal } from '../../utils/terminalApproval'

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

const addableRoles: SwarmRole[] = ['architect', 'product', 'frontend', 'developer', 'code_reviewer', 'performance', 'tester', 'security']
const cliOptions: Array<{ value: AgentCli; label: string; description: string }> = [
  { value: 'codex', label: 'Codex', description: 'OpenAI Codex CLI' },
  { value: 'claude', label: 'Claude', description: 'Claude Code CLI' },
]
const swarmCliPermissionOptions: Array<{
  value: SwarmCliPermissionPreset
  label: string
  title: string
}> = [
  {
    value: 'default',
    label: 'Default permissions',
    title: 'Use the CLI default permission behavior.',
  },
  {
    value: 'auto_workspace',
    label: 'Auto in workspace',
    title: 'Reduce prompts while keeping workspace-scoped guardrails where the CLI supports them.',
  },
  {
    value: 'bypass_all',
    label: 'Bypass permissions',
    title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
]

function RefreshSwarmIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M13.25 7.25A5.25 5.25 0 0 0 4.05 4.1L2.75 5.5m0 0H6m-3.25 0V2.25M2.75 8.75a5.25 5.25 0 0 0 9.2 3.15l1.3-1.4m0 0H10m3.25 0v3.25"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PlaySwarmIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M5.25 3.75v8.5l7-4.25-7-4.25Z"
        fill="currentColor"
      />
    </svg>
  )
}

function PauseSwarmIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M4.75 3.5h2v9h-2v-9Zm4.5 0h2v9h-2v-9Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ZoomInSwarmIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M7.25 11.25a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm2.9-1.1 3.1 3.1M7.25 5.45v3.6M5.45 7.25h3.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ZoomOutSwarmIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M7.25 11.25a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm2.9-1.1 3.1 3.1M5.45 7.25h3.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ResetGraphZoomIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M12.75 5.5A5 5 0 1 0 13 8m-.25-2.5V2.75m0 2.75H10"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FitGraphZoomIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M3.25 6V3.25H6m4 0h2.75V6m0 4v2.75H10m-4 0H3.25V10"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function getParentDirectoryPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : trimmed
}

function getBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed
}

type OpenedSwarmArtifact = {
  path: string
  name: string
  content: string
}

function joinFilePath(basePath: string, childPath: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${childPath.replace(/^[\\/]+/, '')}`
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function normalizeComparablePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const parent = normalizeComparablePath(parentPath)
  const target = normalizeComparablePath(targetPath)
  return target === parent || target.startsWith(`${parent}/`)
}

function resolveArtifactPathForEditor(statePath: string, artifactPathInput: string): string {
  const artifactPath = artifactPathInput.trim()
  if (!artifactPath) throw new Error('Artifact path is required.')
  if (/^https?:\/\//i.test(artifactPath)) {
    throw new Error('Remote artifact links cannot be opened in the editor.')
  }
  if (artifactPath.split(/[\\/]+/).includes('..')) {
    throw new Error('Artifact path must stay inside the Sprint Engine team directory.')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(artifactPath) && !isAbsoluteFilePath(artifactPath)) {
    throw new Error('Only workspace artifact file paths can be opened.')
  }

  const teamDirectory = getParentDirectoryPath(statePath)
  const workspaceRoot = getParentDirectoryPath(getParentDirectoryPath(getParentDirectoryPath(teamDirectory)))
  const targetPath = isAbsoluteFilePath(artifactPath)
    ? artifactPath
    : [
        joinFilePath(workspaceRoot, artifactPath),
        joinFilePath(teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(teamDirectory, candidate))
        ?? joinFilePath(workspaceRoot, artifactPath)

  if (!isPathInsideOrEqual(teamDirectory, targetPath)) {
    throw new Error('Artifact path must stay inside the Sprint Engine team directory.')
  }

  return targetPath
}

const roleSummaries: Record<SwarmRole, string> = {
  architect: 'Plans the run and gates readiness.',
  product: 'Shapes scope, positioning, audience fit, and priority tradeoffs.',
  developer: 'Builds implementation and integration work.',
  frontend: 'Owns interaction design, visual quality, and UI implementation.',
  code_reviewer: 'Reviews implementation quality, regressions, and evidence.',
  performance: 'Reviews latency, CPU, memory, runtime cost, and measurement gaps.',
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
  name: string
}

type RecoveryDialogState = {
  cli: AgentCli
}

type ArtifactActionKind = 'open' | 'approve' | 'requestChanges'

type ArtifactActionState = {
  kind: ArtifactActionKind
  status: 'pending' | 'success' | 'error'
  message: string
}

function buildWorkerRespawnStartupPrompt(
  role: SwarmRole,
  agentId: string,
  reduceTokenConsumption: boolean
): string {
  return [
    'Fetch the canonical sprintengine instructions from the Python tool.',
    reduceTokenConsumption
      ? 'Reduce Token Consumption is enabled. Keep picking up ready tasks with this same agent id until no task is ready, you are blocked, you need user input, or your context window is about 70% full.'
      : null,
    'On Windows, prefer the repo virtual environment command if `sprintengine` or global Python is unreliable:',
    [
      '```powershell',
      `& ".\\.venv\\Scripts\\python.exe" .\\scripts\\sprintengine_tool.py join --role ${role} --id ${agentId}`,
      '```',
    ].join('\n'),
    'Otherwise run:',
    `\`\`\`\nswarm join --role ${role} --id ${agentId}\n\`\`\``,
  ].filter(Boolean).join('\n\n')
}

type SwarmMergeEligibility =
  | { eligible: false; reason: string }
  | {
      eligible: true
      key: string
      targetBranch: string
      worktreePath: string
      worktreeBranch: string
    }

type ExecutionWorkspacePlan = {
  worktreeEnabled: boolean
  worktreePath: string | null
  branch: string | null
  mergeTarget: string | null
}

export default function SprintEngineBoardPanel({ workspaceId, fixedView }: Props) {
  const workspace = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null
  )
  const setSwarmState = useWorkspaceStore((s) => s.setSwarmState)
  const setSwarmAutoEnabled = useWorkspaceStore((s) => s.setSwarmAutoEnabled)
  const setSwarmAutoApproveArtifacts = useWorkspaceStore((s) => s.setSwarmAutoApproveArtifacts)
  const setSwarmKeepDoneAgentTerminals = useWorkspaceStore((s) => s.setSwarmKeepDoneAgentTerminals)
  const setSwarmCliPermissionPreset = useWorkspaceStore((s) => s.setSwarmCliPermissionPreset)
  const setSwarmUseWorktreesForSwarms = useWorkspaceStore((s) => s.setSwarmUseWorktreesForSwarms)
  const addSwarmMember = useWorkspaceStore((s) => s.addSwarmMember)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
  const {
    folderPath: savedFolderPath,
    folderReadyPath,
    folderMissing,
    checkingFolder,
    message: folderStatusMessage,
    checkedPath: folderCheckedPath,
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
  const [showRunSummary, setShowRunSummary] = useState(false)
  const [manualRefreshBusy, setManualRefreshBusy] = useState(false)
  const [artifactActions, setArtifactActions] = useState<Record<string, ArtifactActionState>>({})
  const [planReader, setPlanReader] = useState<PlanReaderState>({
    open: false,
    status: 'idle',
    content: '',
    error: null,
    mode: 'preview',
  })
  const [syncState, setSyncState] = useState<SyncState>({
    status: 'idle',
    message: 'Waiting for a Sprint Engine workspace folder.',
  })

  const swarmState = workspace?.swarmState ?? null
  const swarmContext = workspace?.swarmContext ?? null
  const effectiveView = fixedView ?? activeView
  const folderPath = folderReadyPath
  const agents = workspace?.agents ?? {}
  const autoEnabled = workspace?.swarmAutoState?.enabled ?? false
  const reduceTokenConsumption = useWorkspaceStore((s) => s.appSettings.reduceTokenConsumption)
  const autoApproveArtifacts = workspace?.swarmAutoState?.autoApproveArtifacts ?? false
  const keepDoneAgentTerminals = workspace?.swarmAutoState?.keepDoneAgentTerminals ?? false
  const cliPermissionPreset = workspace?.swarmAutoState?.cliPermissionPreset ?? 'default'
  const useWorktreesForSwarms = workspace?.swarmAutoState?.useWorktreesForSwarms ?? false

  const resolveReadableSwarmStatePath = async (): Promise<string | null> => {
    if (!folderPath) return null
    return swarmContext?.statePath ?? null
  }

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
        message: 'Choose a workspace folder to watch agent-managed Sprint Engine state.',
      })
      return
    }
    if (!folderPath) {
      setSyncState({
        status: folderMissing ? 'error' : 'idle',
        message: folderMissing
          ? `Saved workspace folder is missing: ${savedFolderPath}`
          : 'Checking workspace folder before watching Sprint Engine state.',
      })
      return
    }
    if (!swarmContext?.statePath) {
      setSyncState({
        status: 'idle',
        message: 'Waiting for agent-managed state.',
      })
      return
    }

    setSyncState({
      status: 'live',
      message: `Watching agent-managed state at ${swarmContext.statePath}`,
    })
  }, [folderMissing, folderPath, savedFolderPath, swarmContext?.statePath])

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
    options?: {
      startupPrompt?: string
      freshSession?: boolean
      agentName?: string
      execution?: AgentExecution
    }
  ) {
    const current = agents[agentId]
    const selectedCli = cli ?? current?.cli ?? 'codex'
    const role = swarmState?.swarmAgents[agentId]?.role
    const roleLabel = role
      ? swarmRoleLabels[role]
      : undefined
    const startupPrompt = options?.startupPrompt && options.agentName
      ? prependAgentIdentifier(options.startupPrompt, options.agentName, roleLabel)
      : options?.startupPrompt
    const hasLegacyLaunchedSession =
      current?.cli === undefined
      && Boolean(current?.cliStartRequested || current?.cliHasLaunched || current?.cliSessionId)
    const shouldResetSession =
      hasLegacyLaunchedSession || (current?.cli !== undefined && current.cli !== selectedCli)
    const shouldStartFresh = Boolean(options?.freshSession || shouldResetSession)
    const previousSessionId = current?.cliSessionId
    const nextSessionId = current?.cliStartRequested && previousSessionId && !shouldStartFresh
      ? previousSessionId
      : crypto.randomUUID()

    if (shouldStartFresh && previousSessionId && previousSessionId !== nextSessionId) {
      void window.api.terminalKill(previousSessionId).catch(() => {})
    }

    updateAgent(workspaceId, agentId, {
      name: label,
      ...(options?.execution ? { execution: options.execution } : {}),
      cliStartRequested: true,
      cliSessionId: nextSessionId,
      cliHasLaunched: current?.cliStartRequested && !shouldStartFresh ? current.cliHasLaunched ?? false : false,
      cliOnboardingPromptSent: current?.cliStartRequested && !shouldStartFresh ? current.cliOnboardingPromptSent ?? false : false,
      cli: selectedCli,
      cliStartupPrompt: startupPrompt,
    })
    focusOrAddAgentTab(workspaceId, agentId, label)
  }

  async function ensureWorkspaceFolderReadyForLaunch(agentId: string, label: string): Promise<boolean> {
    if (!savedFolderPath) return true

    const result = folderPath
      ? { ok: true as const, checkedPath: folderPath, message: `Workspace folder is ready: ${folderPath}` }
      : await window.api.checkWorkspaceFolder(savedFolderPath).catch((error): WorkspaceFolderCheckResult => ({
          ok: false,
          status: 'inaccessible',
          path: savedFolderPath,
          checkedPath: savedFolderPath,
          message: error instanceof Error ? error.message : 'Failed to check workspace folder.',
        }))

    if (result.ok) return true

    void recheckFolder()
    await publishDiagnostic({
      level: 'error',
      source: 'filesystem',
      title: `${label} was not started`,
      message: result.message || folderStatusMessage || 'Workspace folder could not be verified.',
      details: [
        `Saved path: ${savedFolderPath}`,
        `Checked path: ${result.checkedPath || folderCheckedPath || savedFolderPath}`,
        `Agent: ${agentId}`,
      ].join('\n'),
      workspaceId,
      workspaceName: workspace?.name,
      agentId,
    })
    return false
  }

  async function startAgentTerminalWhenReady(
    agentId: string,
    label: string,
    cli?: AgentCli,
    options?: {
      startupPrompt?: string
      freshSession?: boolean
      agentName?: string
      execution?: AgentExecution
    }
  ): Promise<boolean> {
    if (!(await ensureWorkspaceFolderReadyForLaunch(agentId, label))) return false
    startAgentTerminal(agentId, label, cli, options)
    return true
  }

  const boardColumns = useMemo(() => {
    if (!swarmState) return []

    return columnMeta.map((column) => ({
      ...column,
      cards: swarmState.tasks.filter(
        (task) => getSwarmTaskBoardColumn(task, swarmState.tasks) === column.key
      ),
    }))
  }, [swarmState])

  const reviewArtifacts = useMemo(
    () => getReviewableSwarmArtifacts(swarmState?.artifacts ?? []),
    [swarmState?.artifacts]
  )

  const artifactsByTaskId = useMemo(
    () => getSwarmArtifactsByTaskId(reviewArtifacts),
    [reviewArtifacts]
  )

  const artifactBlockersByTaskId = useMemo(() => {
    if (!swarmState) return {}
    return Object.fromEntries(
      swarmState.tasks.map((task) => [
        task.id,
        getSwarmArtifactDependencyBlockers(task, swarmState.tasks, reviewArtifacts),
      ])
    )
  }, [reviewArtifacts, swarmState])

  const tasksById = useMemo(
    () => Object.fromEntries((swarmState?.tasks ?? []).map((task) => [task.id, task])),
    [swarmState?.tasks]
  )

  const selectedTask = swarmState?.tasks.find((task) => task.id === selectedTaskId) ?? null

  if (!swarmState) {
    return (
      <div className="flex h-full items-center justify-center bg-[#08090b] text-sm text-[#5a5a63]">
        Sprint Engine workspace data is missing.
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
  const planFilePath = folderPath && swarmContext
    ? getSwarmPlanFilePath(folderPath, swarmContext.teamSlug)
    : null
  const resolvedSelectedAgentId = selectedAgentId ?? architectAgentId ?? roster[0]?.id ?? null
  const workerRoles: SwarmRole[] = ['developer', 'frontend', 'product', 'code_reviewer', 'performance', 'tester', 'security']
  const roleTaskLaunches = workerRoles.flatMap((role) => {
    const activeTask = swarmState.tasks.find((task) =>
      task.role === role && (task.status === 'in_progress' || task.status === 'needs_input')
    )
    const readyTask = readyTasks.find((task) => task.role === role && !task.ownerAgentId)
    const task = activeTask ?? readyTask
    if (!task) return []

    const ownerAgent = task.ownerAgentId ? rosterById[task.ownerAgentId] : undefined
    const agent = ownerAgent ?? roster.find((candidate) =>
      candidate.role === role && runtimeAgentById[candidate.id]?.status !== 'done'
    )
    return [{ role, task, agent }]
  })
  const roleTaskLaunchSet = new Set<SwarmRole>(roleTaskLaunches.map(({ role }) => role))
  const specialistReviewAgents = roster.filter((agent) => agent.role !== 'architect')
  const spawnDialogAgent = spawnDialog ? rosterById[spawnDialog.agentId] : undefined
  const spawnDialogRuntime = spawnDialog
    ? runtimeAgents.find((agent) => agent.agentId === spawnDialog.agentId)
    : undefined
  const spawnDialogAgentState = spawnDialog ? agents[spawnDialog.agentId] : undefined
  const spawnDialogDefaultName = spawnDialogAgent?.label ?? spawnDialog?.agentId ?? ''
  const spawnDialogDisplayName = spawnDialog
    ? normalizeAgentIdentifier(spawnDialog.name) || spawnDialogDefaultName
    : spawnDialogDefaultName
  const spawnDialogIsRunning = Boolean(spawnDialogAgentState?.cliStartRequested)
  const selectedCliOption = cliOptions.find((option) => option.value === spawnDialog?.cli) ?? cliOptions[0]
  const selectedRecoveryCliOption =
    cliOptions.find((option) => option.value === recoveryDialog?.cli) ?? cliOptions[0]
  const hasPlannedTasks = swarmState.tasks.length > 0
  const relinkFolder = async () => {
    const dir = await window.api.openDir()
    if (dir) setFolderPath(workspaceId, dir)
  }
  const refreshSwarmState = async () => {
    if (!folderPath || manualRefreshBusy) return

    setManualRefreshBusy(true)
    setSyncState({ status: 'syncing', message: 'Refreshing Sprint Engine state...' })
    try {
      const stateFilePath = await resolveReadableSwarmStatePath()
      if (!stateFilePath) throw new Error('No workspace folder is ready.')
      const content = await window.api.readfile(stateFilePath)
      const parsed = parseSwarmStateFile(content, getBaseName(getParentDirectoryPath(stateFilePath)))
      setSwarmState(workspaceId, parsed)
      setSyncState({
        status: 'live',
        message: `Refreshed ${parsed.tasks.length} tasks from ${stateFilePath}`,
      })
    } catch (error) {
      setSyncState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to refresh Sprint Engine state.',
      })
    } finally {
      setManualRefreshBusy(false)
    }
  }

  const setArtifactAction = (
    artifactId: string,
    state: ArtifactActionState | null
  ) => {
    setArtifactActions((current) => {
      const next = { ...current }
      if (state) {
        next[artifactId] = state
      } else {
        delete next[artifactId]
      }
      return next
    })
  }

  const requireArtifactStatePath = (): string | null => {
    if (!swarmContext?.statePath) {
      setSyncState({
        status: 'error',
        message: 'This Sprint Engine workspace is missing its selected team context.',
      })
      return null
    }
    return swarmContext.statePath
  }

  const readArtifactForEditor = async (
    statePath: string,
    artifact: SwarmArtifact
  ): Promise<OpenedSwarmArtifact> => {
    const artifactPath = resolveArtifactPathForEditor(statePath, artifact.path)
    const exists = await window.api.pathExists(artifactPath)
    if (!exists) {
      throw new Error(`Artifact file does not exist: ${artifactPath}`)
    }

    const content = await window.api.readfile(artifactPath)
    return {
      path: artifactPath,
      name: getBaseName(artifactPath) || artifact.title || artifact.id,
      content,
    }
  }

  const openArtifact = async (artifact: SwarmArtifact) => {
    const statePath = requireArtifactStatePath()
    if (!statePath) return

    setArtifactAction(artifact.id, { kind: 'open', status: 'pending', message: 'Opening...' })
    try {
      const openedArtifact = await readArtifactForEditor(statePath, artifact)
      openFile(workspaceId, openedArtifact.path, openedArtifact.name, openedArtifact.content)
      setSelectedTaskId(null)
      focusOrAddFileTab(workspaceId, openedArtifact.path, openedArtifact.name)
      setArtifactAction(artifact.id, {
        kind: 'open',
        status: 'success',
        message: 'Opened in editor.',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open artifact.'
      setArtifactAction(artifact.id, {
        kind: 'open',
        status: 'error',
        message,
      })
      setSyncState({
        status: 'error',
        message,
      })
    }
  }

  const resolveArtifactProducerAgentId = (artifact: SwarmArtifact): string | null => {
    const linkedTask = tasksById[artifact.taskId]
    const createdBy = artifact.createdBy.trim()
    if (createdBy && (rosterById[createdBy] || agents[createdBy] || swarmState?.swarmAgents[createdBy])) {
      return createdBy
    }

    if (linkedTask?.ownerAgentId) return linkedTask.ownerAgentId

    if (linkedTask) {
      const runningRoleAgents = roster.filter((agent) =>
        agent.role === linkedTask.role && Boolean(agents[agent.id]?.cliStartRequested)
      )
      if (runningRoleAgents.length === 1) return runningRoleAgents[0].id
    }

    return null
  }

  const focusArtifactProducerTerminal = (artifact: SwarmArtifact): { agentId: string; label: string } | null => {
    const agentId = resolveArtifactProducerAgentId(artifact)
    if (!agentId) {
      setArtifactAction(artifact.id, {
        kind: 'requestChanges',
        status: 'error',
        message: 'No producer terminal is linked to this artifact.',
      })
      return null
    }

    const fallbackLabel = rosterById[agentId]?.label ?? agentId
    const label = getAgentName(agentId, fallbackLabel)
    setSelectedAgentId(agentId)
    focusOrAddAgentTab(workspaceId, agentId, label)
    return { agentId, label }
  }

  const runningArtifactProducerSessionId = async (agentId: string): Promise<string | null> => {
    const sessionId = agents[agentId]?.cliSessionId
    if (sessionId) {
      const status = await window.api.terminalStatus(sessionId).catch(() => ({ running: false }))
      if (status.running) return sessionId
    }

    const sessions = await window.api.terminalList().catch(() => [])
    const runningSession = sessions.find((session) =>
      session.running
      && session.kind === 'agent'
      && session.workspaceId === workspaceId
      && session.agentId === agentId
      && (!swarmContext || session.swarmStatePath === swarmContext.statePath)
    )
    if (!runningSession) return null

    updateAgent(workspaceId, agentId, {
      cliSessionId: runningSession.sessionId,
      cliStartRequested: true,
      cliHasLaunched: true,
      cli: runningSession.cli ?? agents[agentId]?.cli ?? 'codex',
    })
    return runningSession.sessionId
  }

  // Review actions are terminal handoffs. The renderer must not invoke sprintengine
  // Python mutation commands; the producing agent receives the user's decision
  // and updates Sprint Engine state through its own tool flow.
  const approveArtifact = async (artifact: SwarmArtifact) => {
    setArtifactAction(artifact.id, { kind: 'approve', status: 'pending', message: 'Sending approval...' })
    try {
      const target = focusArtifactProducerTerminal(artifact)
      if (!target) return

      const sessionId = await runningArtifactProducerSessionId(target.agentId)
      if (!sessionId) {
        throw new Error(`Opened ${target.label}. Start or wait for the producer CLI before approving.`)
      }

      await sendArtifactApprovalToTerminal(sessionId)
      setArtifactAction(artifact.id, {
        kind: 'approve',
        status: 'success',
        message: `Sent approval to ${target.label}.`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send approval.'
      setArtifactAction(artifact.id, {
        kind: 'approve',
        status: 'error',
        message,
      })
    }
  }

  const requestArtifactChanges = (artifact: SwarmArtifact) => {
    const target = focusArtifactProducerTerminal(artifact)
    if (!target) return

    setArtifactAction(artifact.id, {
      kind: 'requestChanges',
      status: 'success',
      message: `Focused ${target.label}. Type your change request in the terminal.`,
    })
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
              className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
            >
              Retry
            </button>
            <button
              onClick={() => void relinkFolder()}
              className="rounded-md bg-[#6ee7d8]/10 px-2.5 py-1 text-[11px] font-semibold text-[#bff7f1] transition-colors hover:bg-[#6ee7d8]/16"
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
  const showFocusAgentAction = Boolean(focusAgent)
    && (!focusAgentRole || focusAgentRole === 'architect' || !roleTaskLaunchSet.has(focusAgentRole))
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
  const selectedTaskArtifacts = selectedTask ? artifactsByTaskId[selectedTask.id] ?? [] : []
  const selectedTaskArtifactBlockers = selectedTask ? artifactBlockersByTaskId[selectedTask.id] ?? [] : []
  const activateView = (view: SwarmView) => {
    if (fixedView) return
    setActiveView(view)
  }

  const toggleAuto = () => {
    setSwarmAutoEnabled(workspaceId, !autoEnabled)
  }

  const toggleArtifactAutoApproval = () => {
    if (!autoEnabled) return
    setSwarmAutoApproveArtifacts(workspaceId, !autoApproveArtifacts)
  }

  const toggleKeepDoneAgentTerminals = () => {
    setSwarmKeepDoneAgentTerminals(workspaceId, !keepDoneAgentTerminals)
  }

  const toggleUseWorktreesForSwarms = () => {
    setSwarmUseWorktreesForSwarms(workspaceId, !useWorktreesForSwarms)
  }

  const updateCliPermissionPreset = (preset: SwarmCliPermissionPreset) => {
    if (preset === 'bypass_all') {
      const confirmed = window.confirm(
        'Bypass permissions lets spawned Sprint Engine agents run without CLI approval prompts. Use this only in repositories and environments you trust.'
      )
      if (!confirmed) return
    }

    setSwarmCliPermissionPreset(workspaceId, preset)
  }

  const getAgentName = (agentId: string, fallback: string) => agents[agentId]?.name ?? fallback

  const getCustomAgentName = (agentId: string, fallback: string) => {
    const name = agents[agentId]?.name
    return name && name !== fallback ? name : ''
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

    void startAgentTerminalWhenReady(addedAgent.id, addedAgent.label)
    setSelectedAgentId(addedAgent.id)
    setAddMemberOpen(false)
  }

  const openAgentTerminal = (agentId: string) => {
    const fallbackLabel = rosterById[agentId]?.label ?? agentId
    const label = getAgentName(agentId, fallbackLabel)
    setSelectedAgentId(agentId)
    void startAgentTerminalWhenReady(agentId, label)
  }

  const openSpawnDialog = (agentId: string) => {
    const agentState = agents[agentId]
    const defaultName = rosterById[agentId]?.label ?? agentId
    const savedName = agentState?.name && agentState.name !== defaultName ? agentState.name : ''
    setSelectedAgentId(agentId)
    setCliPickerOpen(false)
    setSpawnDialog({
      agentId,
      cli: agentState?.cli ?? 'codex',
      name: savedName,
    })
  }

  const confirmSpawnDialog = async () => {
    if (!spawnDialog) return
    const defaultName = rosterById[spawnDialog.agentId]?.label ?? spawnDialog.agentId
    const agentName = normalizeAgentIdentifier(spawnDialog.name)
    const label = agentName || defaultName
    const started = await startAgentTerminalWhenReady(spawnDialog.agentId, label, spawnDialog.cli, { agentName })
    if (!started) return
    setCliPickerOpen(false)
    setSpawnDialog(null)
  }

  const openReadySpawnDialogForRole = (role: SwarmRole) => {
    const existing = roster.find((agent) =>
      agent.role === role
      && runtimeAgentById[agent.id]?.status !== 'done'
      && !agents[agent.id]?.cliStartRequested
    )
      ?? roster.find((agent) =>
        agent.role === role
        && runtimeAgentById[agent.id]?.status !== 'done'
      )
    const agent = existing ?? addSwarmMember(workspaceId, role)
    if (!agent) return

    openSpawnDialog(agent.id)
  }

  const openReadyTaskWorker = (task: SwarmTask) => {
    if (task.ownerAgentId) {
      const agentId = task.ownerAgentId
      const agent = rosterById[agentId]
      const fallbackLabel = agent?.label ?? agentId
      const label = getAgentName(agentId, fallbackLabel)

      if (agents[agentId]?.cliStartRequested) {
        openAgentTerminal(agentId)
        return
      }

      setSelectedAgentId(agentId)
      void startAgentTerminalWhenReady(agentId, label, agents[agentId]?.cli ?? 'codex', {
        freshSession: true,
        agentName: getCustomAgentName(agentId, fallbackLabel),
        startupPrompt: buildWorkerRespawnStartupPrompt(
          agent?.role ?? task.role,
          agentId,
          reduceTokenConsumption
        ),
      })
      return
    }

    openReadySpawnDialogForRole(task.role)
  }

  const loadPlanReader = async () => {
    if (!swarmState || !folderPath || !swarmContext) {
      setPlanReader((current) => ({
        ...current,
        open: true,
        status: 'error',
        error: !folderPath
          ? 'Choose a workspace folder before reading the Sprint Engine plan.'
          : 'This Sprint Engine workspace is missing its selected team context.',
      }))
      return
    }

    const swarmRootDirectory = getSwarmRootDirectoryPath(folderPath)
    const swarmDirectory = swarmContext.teamDirectoryPath
    const nextPlanFilePath = getSwarmPlanFilePath(folderPath, swarmContext.teamSlug)
    setPlanReader((current) => ({
      ...current,
      open: true,
      status: 'loading',
      error: null,
    }))

    try {
      await window.api.ensureDir(folderPath, 'sprintengine')
      await window.api.ensureDir(swarmRootDirectory, swarmContext.teamSlug)

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
    focusOrAddFileTab(workspaceId, planFilePath, 'plan.md')
    setPlanReader((current) => ({ ...current, open: false }))
  }

  const openRecoveryDialog = () => {
    setCliPickerOpen(false)
    setRecoveryDialog({ cli: 'codex' })
  }

  const confirmRecoveryAudit = async () => {
    if (!recoveryDialog || !architectAgentId || !folderPath) return
    const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
    const label = getAgentName(architectAgentId, fallbackLabel)

    const started = await startAgentTerminalWhenReady(architectAgentId, label, recoveryDialog.cli, {
      freshSession: true,
      agentName: getCustomAgentName(architectAgentId, fallbackLabel),
      startupPrompt: buildRecoveryAuditPrompt(),
    })
    if (!started) return
    setSelectedAgentId(architectAgentId)
    setCliPickerOpen(false)
    setRecoveryDialog(null)
  }

  const requestPlanReviews = () => {
    if (!folderPath || specialistReviewAgents.length === 0) return

    specialistReviewAgents.forEach((agent) => {
      const label = getAgentName(agent.id, agent.label)
      void startAgentTerminalWhenReady(agent.id, label, agents[agent.id]?.cli ?? 'codex', {
        freshSession: true,
        agentName: getCustomAgentName(agent.id, agent.label),
        startupPrompt: buildPlanReviewStartupPrompt(agent.role, agent.id),
      })
    })

    setSelectedAgentId(specialistReviewAgents.at(-1)?.id ?? null)
  }

  const addressPlanReviews = () => {
    if (!folderPath || !architectAgentId) return
    const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
    const label = getAgentName(architectAgentId, fallbackLabel)

    void startAgentTerminalWhenReady(architectAgentId, label, agents[architectAgentId]?.cli ?? 'codex', {
      freshSession: true,
      agentName: getCustomAgentName(architectAgentId, fallbackLabel),
      startupPrompt: buildAddressPlanReviewsPrompt(),
    })
    setSelectedAgentId(architectAgentId)
  }

  const startArchitectMerge = (eligibility: Extract<SwarmMergeEligibility, { eligible: true }>) => {
    if (!architectAgentId) return
    const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
    const label = getAgentName(architectAgentId, fallbackLabel)
    const startupPrompt = buildArchitectMergeStartupPrompt(eligibility.targetBranch, eligibility.worktreePath)
    const existingArchitect = agents[architectAgentId]

    if (existingArchitect?.cliStartRequested && existingArchitect.cliSessionId) {
      focusOrAddAgentTab(workspaceId, architectAgentId, label)
      void window.api.terminalWrite(existingArchitect.cliSessionId, `${startupPrompt}\r`)
      setSelectedAgentId(architectAgentId)
      return
    }

    void startAgentTerminalWhenReady(architectAgentId, label, agents[architectAgentId]?.cli ?? 'codex', {
      freshSession: true,
      agentName: getCustomAgentName(architectAgentId, fallbackLabel),
      startupPrompt,
      execution: {
        mode: 'worktree',
        worktreeId: null,
        cwd: eligibility.worktreePath,
      },
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
              aria-label={autoEnabled ? 'Pause sprintengine auto-run' : 'Start sprintengine auto-run'}
              onClick={toggleAuto}
              title={autoEnabled ? 'Pause sprintengine auto-run' : 'Start sprintengine auto-run'}
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-sm font-semibold transition-colors ${
                autoEnabled
                  ? 'border-[#6ee7d8]/55 bg-[#6ee7d8]/14 text-[#d8fffb] hover:border-[#6ee7d8]/75 hover:bg-[#6ee7d8]/18'
                  : 'border-[#303139] bg-[#111216] text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
              }`}
            >
              {autoEnabled ? <PauseSwarmIcon /> : <PlaySwarmIcon />}
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={autoApproveArtifacts}
              aria-label="Approve all artifacts"
              aria-describedby={!autoEnabled ? 'artifact-auto-approval-disabled' : undefined}
              onClick={toggleArtifactAutoApproval}
              disabled={!autoEnabled}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                autoEnabled && autoApproveArtifacts
                  ? 'border-[#6ee7d8]/45 bg-[#6ee7d8]/12 text-[#d8fffb] hover:border-[#6ee7d8]/65 hover:bg-[#6ee7d8]/16'
                  : 'border-[#303139] bg-[#111216] text-[#8a8a92] hover:bg-[#17181d] hover:text-[#ececee]'
              } disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#111216] disabled:hover:text-[#8a8a92]`}
              title={autoEnabled ? 'Approve all artifacts' : 'Start sprintengine auto-run before approving all artifacts'}
            >
              <span
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  autoEnabled && autoApproveArtifacts ? 'bg-[#6ee7d8]' : 'bg-[#303139]'
                }`}
                aria-hidden="true"
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
                    autoApproveArtifacts ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </span>
              <span>Approve all artifacts</span>
            </button>
            <span id="artifact-auto-approval-disabled" className="sr-only">
              SprintEngine auto-run must be enabled before artifacts can be approved automatically.
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={keepDoneAgentTerminals}
              aria-label="Keep done agent terminals open"
              onClick={toggleKeepDoneAgentTerminals}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                keepDoneAgentTerminals
                  ? 'border-[#6ee7d8]/45 bg-[#6ee7d8]/12 text-[#d8fffb] hover:border-[#6ee7d8]/65 hover:bg-[#6ee7d8]/16'
                  : 'border-[#303139] bg-[#111216] text-[#8a8a92] hover:bg-[#17181d] hover:text-[#ececee]'
              }`}
              title="Keep completed Sprint Engine agent terminals open"
            >
              <span
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  keepDoneAgentTerminals ? 'bg-[#6ee7d8]' : 'bg-[#303139]'
                }`}
                aria-hidden="true"
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
                    keepDoneAgentTerminals ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </span>
              <span>Keep terminals</span>
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={useWorktreesForSwarms}
              aria-label="Use shared sprintengine worktree"
              onClick={toggleUseWorktreesForSwarms}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                useWorktreesForSwarms
                  ? 'border-[#6ee7d8]/45 bg-[#6ee7d8]/12 text-[#d8fffb] hover:border-[#6ee7d8]/65 hover:bg-[#6ee7d8]/16'
                  : 'border-[#303139] bg-[#111216] text-[#8a8a92] hover:bg-[#17181d] hover:text-[#ececee]'
              }`}
              title="Ask the architect to plan a shared sprintengine worktree"
            >
              <span
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  useWorktreesForSwarms ? 'bg-[#6ee7d8]' : 'bg-[#303139]'
                }`}
                aria-hidden="true"
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
                    useWorktreesForSwarms ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </span>
              <span>Shared worktree</span>
            </button>
            <label className="sr-only" htmlFor={`sprintengine-cli-permissions-${workspaceId}`}>
              CLI permissions for sprintengine auto-run
            </label>
            <select
              id={`sprintengine-cli-permissions-${workspaceId}`}
              value={cliPermissionPreset}
              onChange={(event) =>
                updateCliPermissionPreset(event.currentTarget.value as SwarmCliPermissionPreset)
              }
              title={
                swarmCliPermissionOptions.find((option) => option.value === cliPermissionPreset)?.title
                ?? 'CLI permissions for sprintengine auto-run'
              }
              className={`h-8 rounded-md border bg-[#111216] px-2.5 text-sm font-semibold outline-none transition-colors focus:ring-1 ${
                cliPermissionPreset === 'bypass_all'
                  ? 'border-[#ffbf2f]/50 text-[#ffe0a3] focus:ring-[#ffbf2f]/45'
                  : cliPermissionPreset === 'auto_workspace'
                    ? 'border-[#6ee7d8]/40 text-[#d8fffb] focus:ring-[#6ee7d8]/40'
                    : 'border-[#303139] text-[#8a8a92] focus:ring-[#303139]'
              }`}
            >
              {swarmCliPermissionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
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
            <button
              type="button"
              onClick={() => void refreshSwarmState()}
              disabled={!folderPath || manualRefreshBusy}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#838896] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#838896]"
              title="Refresh Sprint Engine state"
              aria-label="Refresh Sprint Engine state"
            >
              <RefreshSwarmIcon />
            </button>
            {showFocusAgentAction && focusAgent ? (
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
                  ? `Open ${focusAgentRoster?.label ?? focusAgent.agentId}`
                  : `Spawn ${focusAgentRoster?.label ?? focusAgent.agentId}`}
              </button>
            ) : null}
            {roleTaskLaunches.map(({ role, task, agent }) => {
              const ownerAgentId = task.ownerAgentId
              const targetAgentId = ownerAgentId ?? agent?.id ?? null
              const targetIsLaunched = targetAgentId ? Boolean(agents[targetAgentId]?.cliStartRequested) : false
              const targetLabel = ownerAgentId
                ? agent?.label ?? ownerAgentId
                : agent?.label ?? swarmRoleLabels[role]
              const actionLabel = ownerAgentId
                ? targetIsLaunched ? `Open ${targetLabel}` : `Respawn ${targetLabel}`
                : targetIsLaunched ? `Open ${targetLabel}` : `Spawn ${swarmRoleLabels[role]}`
              return (
                <button
                  key={role}
                  onClick={() => {
                    if (!ownerAgentId && targetAgentId && targetIsLaunched) {
                      openAgentTerminal(targetAgentId)
                    } else {
                      openReadyTaskWorker(task)
                    }
                  }}
                  className="rounded-md bg-[#6ee7d8]/10 px-3 py-1.5 text-sm font-semibold text-[#d8fffb] transition-colors hover:bg-[#6ee7d8]/16"
                >
                  {actionLabel}
                </button>
              )
            })}
            {architectAgentId && showPlanningActions && roleTaskLaunches.length === 0 ? (
              <button
                onClick={() => openSpawnDialog(architectAgentId)}
                className="rounded-md bg-[#ffbf2f]/12 px-3 py-1.5 text-sm font-semibold text-[#ffe0a3] transition-colors hover:bg-[#ffbf2f]/16"
              >
                {agents[architectAgentId]?.cliStartRequested ? 'Open Architect' : 'Spawn Architect'}
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
                  className="absolute right-0 top-[calc(100%+8px)] z-30 w-56 overflow-hidden rounded-md bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.32)]"
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
        <div
          className={`mt-2 truncate text-[11px] ${
            syncState.status === 'error'
              ? 'text-[#ff787c]'
              : syncState.status === 'syncing'
                ? 'text-[#ffd58a]'
                : 'text-[#6f7480]'
          }`}
          title={syncState.message}
        >
          {syncState.message}
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
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowRunSummary(true)}
                className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#d4ffdc] transition-colors hover:bg-[#30d158]/12"
              >
                View Run Summary
              </button>
              <SwarmArchitectMergeAction
                workspaceId={workspaceId}
                workspace={workspace}
                swarmState={swarmState}
                planFilePath={planFilePath}
                repoRoot={folderPath}
                architectAgentId={architectAgentId}
                onStart={startArchitectMerge}
              />
            </div>
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
          reviewArtifacts={reviewArtifacts}
          artifactActions={artifactActions}
          onSelectAgent={(agentId) => {
            if (agents[agentId]?.cliStartRequested) {
              openAgentTerminal(agentId)
            } else {
              openSpawnDialog(agentId)
            }
          }}
          onSelectTask={setSelectedTaskId}
          onAddMember={openAddMemberDialog}
          onReadPlan={() => void loadPlanReader()}
          onOpenArtifact={(artifact) => void openArtifact(artifact)}
          onApproveArtifact={(artifact) => void approveArtifact(artifact)}
          onRequestArtifactChanges={requestArtifactChanges}
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
            <div className="col-span-full flex h-full min-h-[320px] items-center justify-center p-6 text-center">
              <div className="max-w-xl">
                <div className="text-sm font-semibold text-[#ececee]">Waiting for the architect plan</div>
                <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">
                  The board will populate as the architect adds tasks through the Sprint Engine tool.
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
                const taskArtifacts = artifactsByTaskId[task.id] ?? []
                const quickOpenArtifact = task.status === 'needs_input'
                  ? getPrimaryTaskArtifact(taskArtifacts)
                  : null
                const quickOpenArtifactAction = quickOpenArtifact
                  ? artifactActions[quickOpenArtifact.id]
                  : undefined
                const quickOpenArtifactPending = quickOpenArtifactAction?.status === 'pending'
                const mobileDecisionSummary = formatTaskMobileDecisionSummary(taskArtifacts)
                const taskArtifactBlockers = artifactBlockersByTaskId[task.id] ?? []
                const actionLabel = task.ownerAgentId
                  ? ownerCliRunning ? 'Open Terminal' : 'Respawn'
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
                    {taskArtifacts.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className="rounded bg-[#17181d] px-1.5 py-0.5 text-[10px] font-semibold text-[#d7d7dc]">
                          {formatArtifactSummary(taskArtifacts)}
                        </span>
                        {mobileDecisionSummary ? (
                          <span className="rounded bg-[#6ee7d8]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#bff7f1]">
                            {mobileDecisionSummary}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {taskArtifactBlockers.length > 0 ? (
                      <div className="mt-2 line-clamp-2 border-l-2 border-[#ffbf2f]/70 pl-2 text-[11px] leading-5 text-[#ffe0a3]">
                        Waiting on {formatArtifactBlockerSummary(taskArtifactBlockers)}
                      </div>
                    ) : null}
                    {showTaskAction || quickOpenArtifact ? (
                      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                        {quickOpenArtifact ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              void openArtifact(quickOpenArtifact)
                            }}
                            onKeyDown={(event) => {
                              event.stopPropagation()
                            }}
                            disabled={quickOpenArtifactPending}
                            title={quickOpenArtifact.title}
                            className="rounded bg-[#ffbf2f]/12 px-2 py-1 text-[11px] font-semibold text-[#ffe0a3] transition-colors hover:bg-[#ffbf2f]/18 hover:text-[#fff0c8] disabled:opacity-45 disabled:hover:bg-[#ffbf2f]/12 disabled:hover:text-[#ffe0a3]"
                          >
                            {quickOpenArtifactPending && quickOpenArtifactAction?.kind === 'open'
                              ? 'Opening...'
                              : 'Open Artifact'}
                          </button>
                        ) : null}
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
          <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.42)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#30d158]">
                  Verify Progress
                </div>
                <h3 className="truncate text-[20px] font-semibold tracking-tight text-[#ececee]">
                  Architect Audit
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">
                  The Architect will back up state.yaml, check each task in order, and update task status through the sprintengine Python tool.
                </p>
              </div>
              <button
                onClick={() => {
                  setCliPickerOpen(false)
                  setRecoveryDialog(null)
                }}
                className="rounded-md px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
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
                  className="flex min-h-[58px] w-full items-center gap-3 rounded-md bg-[#111216] px-3 text-left text-[#ececee] outline-none transition-colors hover:bg-[#17181d] focus:ring-1 focus:ring-[#303139]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[#9a9aa2]">
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
                    className="absolute left-0 right-0 top-[76px] z-30 overflow-hidden rounded-md bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.32)]"
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
                              ? 'bg-[#17181d] text-[#ececee]'
                              : 'text-[#d7d7dc] hover:bg-[#17181d] hover:text-[#ececee]'
                          }`}
                        >
                          <span
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
                              selected
                                ? 'text-[#9a9aa2]'
                                : 'text-[#5a5a63]'
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
                            <svg className="h-4 w-4 shrink-0 text-[#9a9aa2]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
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
                The Architect runs the audit in a terminal and writes updates to the watched state file.
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
          <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.42)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#6ee7d8]">
                  Spawn Agent
                </div>
                <h3 className="truncate text-[20px] font-semibold tracking-tight text-[#ececee]">
                  {spawnDialogDisplayName}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">
                  Choose the CLI and optional identifier for this specialist.
                </p>
              </div>
              <button
                onClick={() => {
                  setCliPickerOpen(false)
                  setSpawnDialog(null)
                }}
                className="rounded-md px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Close
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                <MetaItem label="Role" value={swarmRoleLabels[spawnDialogAgent.role]} />
                <MetaItem label="Status" value={runtimeStatusLabel(spawnDialogRuntime?.status ?? 'idle')} />
              </div>

              <label className="block">
                <span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Name
                </span>
                <input
                  type="text"
                  value={spawnDialog.name}
                  onChange={(event) => {
                    setSpawnDialog((current) =>
                      current ? { ...current, name: event.target.value } : current
                    )
                  }}
                  placeholder={spawnDialogDefaultName}
                  className="h-10 w-full rounded-md bg-[#111216] px-3 text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] hover:bg-[#17181d] focus:ring-1 focus:ring-[#6ee7d8]/50"
                />
              </label>

              <div className="relative">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  CLI
                </div>
                <button
                  type="button"
                  onClick={() => setCliPickerOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={cliPickerOpen}
                  className="flex min-h-[58px] w-full items-center gap-3 rounded-md bg-[#111216] px-3 text-left text-[#ececee] outline-none transition-colors hover:bg-[#17181d] focus:ring-1 focus:ring-[#303139]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[#9a9aa2]">
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
                    className="absolute left-0 right-0 top-[76px] z-30 overflow-hidden rounded-md bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.32)]"
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
                              ? 'bg-[#17181d] text-[#ececee]'
                              : 'text-[#d7d7dc] hover:bg-[#17181d] hover:text-[#ececee]'
                          }`}
                        >
                          <span
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
                              selected
                                ? 'text-[#9a9aa2]'
                                : 'text-[#5a5a63]'
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
                            <svg className="h-4 w-4 shrink-0 text-[#9a9aa2]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
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
          <div className="max-h-[90vh] w-full max-w-[920px] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.42)]">
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
                className="rounded-md px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
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
                <div className="border-l border-[#ffbf2f]/70 pl-3 text-sm text-[#ffe0a3]">
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

              {selectedTaskArtifactBlockers.length > 0 ? (
                <ArtifactBlockerList blockers={selectedTaskArtifactBlockers} />
              ) : null}

              {selectedTask.ownerAgentId && selectedTaskCanManageWorker ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
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
                    className="rounded-md px-4 py-2 text-sm font-semibold text-[#ececee] transition-colors hover:bg-[#17181d]"
                  >
                    {selectedTaskOwnerCliRunning ? 'Open Terminal' : 'Respawn'}
                  </button>
                </div>
              ) : null}

              {selectedTaskCanSpawnWorker ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
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
                    className="rounded-md bg-[#6ee7d8] px-4 py-2 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea]"
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

              <SwarmArtifactList
                artifacts={selectedTaskArtifacts}
                tasksById={tasksById}
                actions={artifactActions}
                emptyLabel="No review artifacts are attached to this task."
                onSelectTask={(taskId) => setSelectedTaskId(taskId)}
                onOpenArtifact={(artifact) => void openArtifact(artifact)}
                onApproveArtifact={(artifact) => void approveArtifact(artifact)}
                onRequestArtifactChanges={requestArtifactChanges}
              />

              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Evidence Summary
                </div>
                <div className="text-[#d7d7dc]">
                  {selectedTask.evidence.summary || 'No completion summary recorded yet.'}
                </div>
              </div>

              {selectedTask.feedback ? (
                <AgentFeedback feedback={selectedTask.feedback} />
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
            </div>
          </div>
        </div>
      )}

      {showRunSummary ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[980px] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.42)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#30d158]">
                  Run Summary
                </div>
                <h3 className="text-[14px] font-semibold tracking-tight text-[#ececee]">
                  {formatSwarmGoal(swarmState.goal)}
                </h3>
                <p className="mt-2 text-sm text-[#9a9aa2]">
                  Final evidence collected from completed sprintengine task cards.
                </p>
              </div>
              <button
                onClick={() => setShowRunSummary(false)}
                className="rounded-md px-3 py-2 text-sm text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
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
                title="Agent Feedback"
                items={runSummary.feedbackSummaries}
                emptyLabel="No agent feedback recorded."
              />
              <SectionList
                title="Prompt Improvement Signals"
                items={runSummary.promptImprovementSignals}
                emptyLabel="No prompt improvement signals recorded."
              />
              <SectionList
                title="Role Findings"
                items={runSummary.findingSummaries}
                emptyLabel="No role findings recorded."
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

              <div className="border-l border-[#ffbf2f]/70 pl-3 text-sm text-[#ffe0a3]">
                Next step: manually test the uncommitted changes in the workspace before committing or reverting.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {addMemberOpen ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[760px] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.42)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  SprintEngine Roster
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
                    className={`w-full rounded-md border-l-2 px-3 py-3 text-left transition-colors ${
                      selected
                        ? 'border-l-[#6ee7d8] bg-[#6ee7d8]/8 text-[#ececee]'
                        : 'border-l-transparent text-[#d7d7dc] hover:bg-[#17181d]'
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <span
                        className="hidden h-8 w-8 shrink-0 items-center justify-center rounded border bg-[#111216] sm:flex"
                        style={{
                          borderColor: selected ? swarmRoleAccent[role] : '#303139',
                          color: '#9a9aa2',
                        }}
                      >
                        <SwarmRoleIcon role={role} className="h-4 w-4" />
                      </span>
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
          <div className="flex max-h-[90vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-xl border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.42)]">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#1f2025] px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Architect Plan
                </div>
                <h3 className="truncate text-[20px] font-semibold tracking-tight text-[#ececee]">
                  {planFilePath ?? '.multi-code/sprintengine/plan.md'}
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
                    Open Architect
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

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1f2025] bg-[#0d0e11] px-5 py-4">
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
                  className="rounded-md px-4 py-2 text-sm font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
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
  reviewArtifacts,
  artifactActions,
  onSelectAgent,
  onSelectTask,
  onAddMember,
  onReadPlan,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
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
  reviewArtifacts: SwarmArtifact[]
  artifactActions: Record<string, ArtifactActionState>
  onSelectAgent: (agentId: string) => void
  onSelectTask: (taskId: string) => void
  onAddMember: () => void
  onReadPlan: () => void
  onOpenArtifact: (artifact: SwarmArtifact) => void
  onApproveArtifact: (artifact: SwarmArtifact) => void
  onRequestArtifactChanges: (artifact: SwarmArtifact) => void
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
      code_reviewer: { open: 0, ready: 0 },
      performance: { open: 0, ready: 0 },
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
  const tasksById = useMemo(
    () => Object.fromEntries(swarmState.tasks.map((task) => [task.id, task])),
    [swarmState.tasks]
  )
  const blockedByArtifacts = useMemo(() => (
    swarmState.tasks
      .map((task) => ({
        task,
        blockers: getSwarmArtifactDependencyBlockers(task, swarmState.tasks, reviewArtifacts),
      }))
      .filter(({ blockers }) => blockers.length > 0)
  ), [reviewArtifacts, swarmState.tasks])

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
              className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
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

            <SwarmArtifactList
              artifacts={reviewArtifacts}
              tasksById={tasksById}
              actions={artifactActions}
              emptyLabel="No review artifacts are registered for this sprintengine run."
              onSelectTask={onSelectTask}
              onOpenArtifact={onOpenArtifact}
              onApproveArtifact={onApproveArtifact}
              onRequestArtifactChanges={onRequestArtifactChanges}
            />

            {blockedByArtifacts.length > 0 ? (
              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Blocked By Review
                </div>
                <div className="divide-y divide-[#1f2025] border-y border-[#1f2025]">
                  {blockedByArtifacts.map(({ task, blockers }) => (
                    <button
                      key={task.id}
                      onClick={() => onSelectTask(task.id)}
                      className="block w-full px-1 py-3 text-left transition-colors hover:bg-[#111216]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-[#ececee]">
                          {task.id}: {task.title}
                        </span>
                        <span className="text-[11px] font-semibold text-[#ffe0a3]">
                          Waiting on {formatArtifactBlockerSummary(blockers)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
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
              className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
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
                    {isLaunched ? 'Open Terminal' : `Spawn ${swarmRoleLabels[agent.role]}`}
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
    el.style.setProperty('--sprintengine-cursor-x', `${event.clientX - rect.left}px`)
    el.style.setProperty('--sprintengine-cursor-y', `${event.clientY - rect.top}px`)
    el.style.setProperty('--sprintengine-cursor-opacity', '1')
  }

  const clearMapCursor = () => {
    mapCanvasRef.current?.style.setProperty('--sprintengine-cursor-opacity', '0')
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
              'radial-gradient(circle at var(--sprintengine-cursor-x, 50%) var(--sprintengine-cursor-y, 50%), black 0, rgba(0,0,0,0.65) 18px, transparent 42px)',
            opacity: 'var(--sprintengine-cursor-opacity, 0)',
            WebkitMaskImage:
              'radial-gradient(circle at var(--sprintengine-cursor-x, 50%) var(--sprintengine-cursor-y, 50%), black 0, rgba(0,0,0,0.65) 18px, transparent 42px)',
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
                  color: '#9a9aa2',
                  boxShadow: selected ? `0 0 0 3px ${hexToRgba(swarmRoleAccent[node.agent.role], 0.16)}` : undefined,
                }}
              >
                <SwarmRoleIcon role={node.agent.role} className="h-7 w-7" />
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
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">SprintEngine State</div>
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
                  color: '#9a9aa2',
                }}
              >
                <SwarmRoleIcon role={selectedAgent.role} className="h-7 w-7" />
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
  const [graphZoom, setGraphZoom] = useState(defaultTaskGraphZoom)
  const graphCanvasRef = useRef<HTMLDivElement | null>(null)
  const graphScrollRef = useRef<HTMLDivElement | null>(null)
  const lastCenteredKeyRef = useRef<string | null>(null)
  const zoomAnchorRef = useRef<TaskGraphZoomAnchor | null>(null)

  const captureZoomAnchor = (viewportX?: number, viewportY?: number): TaskGraphZoomAnchor | null => {
    const scrollEl = graphScrollRef.current
    if (!scrollEl) return null

    const resolvedViewportX = viewportX ?? scrollEl.clientWidth / 2
    const resolvedViewportY = viewportY ?? scrollEl.clientHeight / 2

    return {
      graphX: (scrollEl.scrollLeft + resolvedViewportX) / graphZoom,
      graphY: (scrollEl.scrollTop + resolvedViewportY) / graphZoom,
      viewportX: resolvedViewportX,
      viewportY: resolvedViewportY,
    }
  }

  const setGraphZoomFromAnchor = (
    nextZoom: number,
    anchor: TaskGraphZoomAnchor | null = captureZoomAnchor()
  ) => {
    if (Math.abs(nextZoom - graphZoom) < 0.001) return
    zoomAnchorRef.current = anchor
    setGraphZoom(nextZoom)
  }

  const fitGraphToViewport = () => {
    const scrollEl = graphScrollRef.current
    if (!scrollEl) return

    const availableWidth = Math.max(1, scrollEl.clientWidth - 48)
    const availableHeight = Math.max(1, scrollEl.clientHeight - 48)
    const fitZoom = Math.min(1, availableWidth / graph.canvasWidth, availableHeight / graph.canvasHeight)
    setGraphZoomFromAnchor(Math.max(minTaskGraphZoom, Math.min(maxTaskGraphZoom, fitZoom)))
  }

  useEffect(() => {
    const scrollEl = graphScrollRef.current
    const focusNode = focusTaskId ? graph.nodesById[focusTaskId] : null
    if (!scrollEl || !focusNode) return

    const centerKey = `${focusTaskId}:${graph.canvasWidth}:${graph.canvasHeight}`
    if (lastCenteredKeyRef.current === centerKey) return
    lastCenteredKeyRef.current = centerKey

    const frame = window.requestAnimationFrame(() => {
      scrollEl.scrollTo({
        left: Math.max(0, focusNode.x * graphZoom - scrollEl.clientWidth / 2),
        top: Math.max(0, focusNode.y * graphZoom - scrollEl.clientHeight / 2),
        behavior: 'smooth',
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [focusTaskId, graph, graphZoom])

  useEffect(() => {
    const scrollEl = graphScrollRef.current
    const anchor = zoomAnchorRef.current
    if (!scrollEl || !anchor) return
    zoomAnchorRef.current = null

    const frame = window.requestAnimationFrame(() => {
      scrollEl.scrollLeft = Math.max(0, anchor.graphX * graphZoom - anchor.viewportX)
      scrollEl.scrollTop = Math.max(0, anchor.graphY * graphZoom - anchor.viewportY)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [graphZoom])

  const updateGraphCursor = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = graphCanvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--sprintengine-cursor-x', `${(event.clientX - rect.left) / graphZoom}px`)
    el.style.setProperty('--sprintengine-cursor-y', `${(event.clientY - rect.top) / graphZoom}px`)
    el.style.setProperty('--sprintengine-cursor-opacity', '1')
  }

  const clearGraphCursor = () => {
    graphCanvasRef.current?.style.setProperty('--sprintengine-cursor-opacity', '0')
  }

  const handleGraphWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return

    event.preventDefault()
    const scrollEl = graphScrollRef.current
    if (!scrollEl) return

    const rect = scrollEl.getBoundingClientRect()
    const anchor = captureZoomAnchor(event.clientX - rect.left, event.clientY - rect.top)
    setGraphZoomFromAnchor(getNextTaskGraphZoom(graphZoom, event.deltaY < 0 ? 'in' : 'out'), anchor)
  }

  const terminalCount = graph.terminalTaskIds.length
  const zoomPercent = Math.round(graphZoom * 100)
  const canZoomOut = graphZoom > minTaskGraphZoom + 0.001
  const canZoomIn = graphZoom < maxTaskGraphZoom - 0.001

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#08090b]">
      <div className="absolute right-4 top-4 z-30 flex items-center gap-1 rounded-md bg-[#0d0e11]/92 p-1 shadow-[0_14px_38px_rgba(0,0,0,0.28)] backdrop-blur">
        <button
          type="button"
          onClick={() => setGraphZoomFromAnchor(getNextTaskGraphZoom(graphZoom, 'out'))}
          disabled={!canZoomOut}
          className="flex h-8 w-8 items-center justify-center rounded text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#9a9aa2]"
          aria-label="Zoom out task graph"
          title="Zoom out"
        >
          <ZoomOutSwarmIcon />
        </button>
        <div className="w-12 text-center text-[11px] font-semibold tabular-nums text-[#d7d7dc]" aria-live="polite">
          {zoomPercent}%
        </div>
        <button
          type="button"
          onClick={() => setGraphZoomFromAnchor(getNextTaskGraphZoom(graphZoom, 'in'))}
          disabled={!canZoomIn}
          className="flex h-8 w-8 items-center justify-center rounded text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#9a9aa2]"
          aria-label="Zoom in task graph"
          title="Zoom in"
        >
          <ZoomInSwarmIcon />
        </button>
        <button
          type="button"
          onClick={fitGraphToViewport}
          className="flex h-8 w-8 items-center justify-center rounded text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
          aria-label="Fit task graph to viewport"
          title="Fit graph"
        >
          <FitGraphZoomIcon />
        </button>
        <button
          type="button"
          onClick={() => setGraphZoomFromAnchor(defaultTaskGraphZoom)}
          disabled={Math.abs(graphZoom - defaultTaskGraphZoom) < 0.001}
          className="flex h-8 w-8 items-center justify-center rounded text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#9a9aa2]"
          aria-label="Reset task graph zoom"
          title="Reset zoom"
        >
          <ResetGraphZoomIcon />
        </button>
      </div>
      <div
        ref={graphScrollRef}
        onPointerEnter={updateGraphCursor}
        onPointerMove={updateGraphCursor}
        onPointerLeave={clearGraphCursor}
        onWheel={handleGraphWheel}
        className="h-full min-h-[460px] overflow-auto"
      >
        <div
          className="relative"
          style={{
            width: graph.canvasWidth * graphZoom,
            height: graph.canvasHeight * graphZoom,
          }}
        >
          <div
            ref={graphCanvasRef}
            className="relative"
            style={{
              width: graph.canvasWidth,
              height: graph.canvasHeight,
              transform: `scale(${graphZoom})`,
              transformOrigin: 'top left',
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
                  'radial-gradient(circle at var(--sprintengine-cursor-x, 50%) var(--sprintengine-cursor-y, 50%), black 0, rgba(0,0,0,0.65) 18px, transparent 42px)',
                opacity: 'var(--sprintengine-cursor-opacity, 0)',
                WebkitMaskImage:
                  'radial-gradient(circle at var(--sprintengine-cursor-x, 50%) var(--sprintengine-cursor-y, 50%), black 0, rgba(0,0,0,0.65) 18px, transparent 42px)',
              }}
            />

            {(graph.hasCycle || graph.missingDependencyCount > 0) ? (
            <div className="absolute left-4 top-4 z-20 max-w-md border-l border-[#ffbf2f]/60 bg-[#08090b]/88 px-3 py-2 text-sm leading-6 text-[#ffe0a3] backdrop-blur">
              {graph.hasCycle ? 'A dependency cycle was detected. ' : ''}
              {graph.missingDependencyCount > 0
                ? `${graph.missingDependencyCount} dependency ${graph.missingDependencyCount === 1 ? 'reference is' : 'references are'} missing.`
                : ''}
            </div>
          ) : null}

          {swarmState.tasks.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              <div className="max-w-xl">
                <div className="text-sm font-semibold text-[#ececee]">Waiting for the architect plan</div>
                <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">
                  The dependency graph will appear as tasks are added through the Sprint Engine tool.
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
      </div>
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

type TaskGraphZoomAnchor = {
  graphX: number
  graphY: number
  viewportX: number
  viewportY: number
}

const taskGraphZoomLevels = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2]
const defaultTaskGraphZoom = 1
const minTaskGraphZoom = taskGraphZoomLevels[0]
const maxTaskGraphZoom = taskGraphZoomLevels[taskGraphZoomLevels.length - 1]

function getNextTaskGraphZoom(currentZoom: number, direction: 'in' | 'out'): number {
  if (direction === 'in') {
    return taskGraphZoomLevels.find((level) => level > currentZoom + 0.001) ?? taskGraphZoomLevels[taskGraphZoomLevels.length - 1]
  }

  return [...taskGraphZoomLevels].reverse().find((level) => level < currentZoom - 0.001) ?? taskGraphZoomLevels[0]
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

const feedbackScoreLabels: Array<{ key: keyof SwarmTaskFeedback['scores']; label: string }> = [
  { key: 'directiveClarityPct', label: 'Directive clarity' },
  { key: 'taskClarityPct', label: 'Task clarity' },
  { key: 'acceptanceCriteriaClarityPct', label: 'Acceptance clarity' },
  { key: 'swarmToolEffectivenessPct', label: 'Sprint Engine tool' },
  { key: 'promptOptimizationPct', label: 'Prompt fit' },
  { key: 'contextFitPct', label: 'Context fit' },
  { key: 'hallucinationRiskPct', label: 'Hallucination risk' },
  { key: 'roleFitPct', label: 'Role fit' },
  { key: 'autonomyPct', label: 'Autonomy' },
  { key: 'confidencePct', label: 'Confidence' },
]

const feedbackIssueCategoryLabels: Record<SwarmTaskFeedbackIssue['category'], string> = {
  system_prompt: 'System Prompt',
  role_prompt: 'Role Prompt',
  task_card: 'Task Card',
  acceptance_criteria: 'Acceptance Criteria',
  context: 'Context',
  tooling: 'Tooling',
  coordination: 'Coordination',
  validation: 'Validation',
  permissions: 'Permissions',
  ui: 'UI',
  other: 'Other',
}

const feedbackIssueSeverityLabels: Record<SwarmTaskFeedbackIssue['severity'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const feedbackIssueStatusLabels: Record<NonNullable<SwarmTaskFeedbackIssue['status']>, string> = {
  new: 'New',
  reviewed: 'Reviewed',
  applied: 'Applied',
  rejected: 'Rejected',
  deferred: 'Deferred',
}

const feedbackFindingKindLabels: Record<SwarmTaskFeedbackFinding['kind'], string> = {
  code_bug: 'Code Bug',
  security_issue: 'Security Issue',
  product_requirement_violation: 'Requirement Violation',
  test_gap: 'Test Gap',
  accessibility_issue: 'Accessibility Issue',
  performance_issue: 'Performance Issue',
  reliability_issue: 'Reliability Issue',
  documentation_gap: 'Documentation Gap',
  other: 'Other',
}

const feedbackFindingSeverityLabels: Record<SwarmTaskFeedbackFinding['severity'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

const feedbackFindingAreaLabels: Record<SwarmTaskFeedbackFinding['area'], string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  database: 'Database',
  networking: 'Networking',
  auth: 'Auth',
  security: 'Security',
  filesystem: 'Filesystem',
  cli: 'CLI',
  ipc: 'IPC',
  mobile: 'Mobile',
  testing: 'Testing',
  performance: 'Performance',
  docs: 'Docs',
  product: 'Product',
  other: 'Other',
}

const feedbackFindingStatusLabels: Record<NonNullable<SwarmTaskFeedbackFinding['status']>, string> = {
  open: 'Open',
  accepted: 'Accepted',
  fixed: 'Fixed',
  rejected: 'Rejected',
  deferred: 'Deferred',
}

function AgentFeedback({ feedback }: { feedback: SwarmTaskFeedback }) {
  const scores = feedbackScoreLabels.flatMap((metric) => {
    const value = feedback.scores[metric.key]
    return typeof value === 'number' ? [{ ...metric, value }] : []
  })

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
          Agent Feedback
        </div>
        <div className="text-[11px] text-[#5a5a63]">
          {feedback.agentId} - {formatTimestamp(feedback.capturedAt)}
        </div>
      </div>
      {scores.length > 0 ? (
        <div className="grid gap-x-4 gap-y-2 md:grid-cols-2">
          {scores.map((metric) => (
            <div key={metric.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[12px]">
              <span className="text-[#9a9aa2]">{metric.label}</span>
              <span className="font-mono text-[#ececee]">{metric.value}%</span>
            </div>
          ))}
        </div>
      ) : null}
      {feedback.topFriction ? (
        <div className="mt-3 text-[12px] text-[#d7d7dc]">
          <span className="text-[#9a9aa2]">Top friction: </span>{feedback.topFriction}
        </div>
      ) : null}
      {feedback.suggestedImprovement ? (
        <div className="mt-1 text-[12px] text-[#d7d7dc]">
          <span className="text-[#9a9aa2]">Suggested improvement: </span>{feedback.suggestedImprovement}
        </div>
      ) : null}
      {feedback.issues && feedback.issues.length > 0 ? (
        <PromptImprovementIssues issues={feedback.issues} className="mt-4" />
      ) : null}
      {feedback.findings && feedback.findings.length > 0 ? (
        <RoleFindings findings={feedback.findings} className="mt-4" />
      ) : null}
    </div>
  )
}

function PromptImprovementIssues({
  issues,
  className = '',
}: {
  issues: SwarmTaskFeedbackIssue[]
  className?: string
}) {
  if (issues.length === 0) return null

  return (
    <div className={className}>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
        Prompt Improvement Signals
      </div>
      <div className="space-y-3">
        {issues.map((issue) => (
          <div key={issue.id} className="rounded-md border border-[#1f2025] bg-[#0f1014] p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-semibold text-[#ececee]">{issue.title}</span>
              <span className="text-[#5a5a63]">{feedbackIssueCategoryLabels[issue.category]}</span>
              <span className="text-[#5a5a63]">{feedbackIssueSeverityLabels[issue.severity]}</span>
              <span className="text-[#5a5a63]">{feedbackIssueStatusLabels[issue.status ?? 'new']}</span>
              {issue.target ? <span className="font-mono text-[#7f8189]">{issue.target}</span> : null}
            </div>
            <div className="mt-2 text-[12px] leading-5 text-[#d7d7dc]">{issue.detail}</div>
            {issue.evidence ? (
              <div className="mt-2 text-[12px] leading-5 text-[#9a9aa2]">
                Evidence: {issue.evidence}
              </div>
            ) : null}
            {issue.suggestedPromptChange ? (
              <div className="mt-2 text-[12px] leading-5 text-[#d7d7dc]">
                <span className="text-[#9a9aa2]">Prompt change: </span>{issue.suggestedPromptChange}
              </div>
            ) : null}
            {issue.suggestedProcessChange ? (
              <div className="mt-1 text-[12px] leading-5 text-[#d7d7dc]">
                <span className="text-[#9a9aa2]">Process change: </span>{issue.suggestedProcessChange}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function RoleFindings({
  findings,
  className = '',
}: {
  findings: SwarmTaskFeedbackFinding[]
  className?: string
}) {
  if (findings.length === 0) return null

  return (
    <div className={className}>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
        Role Findings
      </div>
      <div className="space-y-3">
        {findings.map((finding) => (
          <div key={finding.id} className="rounded-md border border-[#1f2025] bg-[#0f1014] p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-semibold text-[#ececee]">{finding.title}</span>
              <span className="text-[#5a5a63]">{feedbackFindingKindLabels[finding.kind]}</span>
              <span className="text-[#5a5a63]">{feedbackFindingSeverityLabels[finding.severity]}</span>
              <span className="text-[#5a5a63]">{feedbackFindingAreaLabels[finding.area]}</span>
              <span className="text-[#5a5a63]">{feedbackFindingStatusLabels[finding.status ?? 'open']}</span>
              {finding.requirementId ? <span className="font-mono text-[#7f8189]">{finding.requirementId}</span> : null}
              {finding.file ? <span className="font-mono text-[#7f8189] [overflow-wrap:anywhere]">{finding.file}</span> : null}
            </div>
            <div className="mt-2 text-[12px] leading-5 text-[#d7d7dc]">{finding.detail}</div>
            {finding.recommendation ? (
              <div className="mt-2 text-[12px] leading-5 text-[#d7d7dc]">
                <span className="text-[#9a9aa2]">Recommendation: </span>{finding.recommendation}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function SwarmArtifactList({
  artifacts,
  tasksById,
  actions,
  emptyLabel,
  onSelectTask,
  onOpenArtifact,
  onApproveArtifact,
  onRequestArtifactChanges,
}: {
  artifacts: SwarmArtifact[]
  tasksById: Record<string, SwarmTask | undefined>
  actions: Record<string, ArtifactActionState>
  emptyLabel: string
  onSelectTask: (taskId: string) => void
  onOpenArtifact: (artifact: SwarmArtifact) => void
  onApproveArtifact: (artifact: SwarmArtifact) => void
  onRequestArtifactChanges: (artifact: SwarmArtifact) => void
}) {
  const sortedArtifacts = [...artifacts].sort((a, b) => {
    const statusOrder = ['ready_for_review', 'changes_requested', 'draft', 'approved', 'superseded']
    const statusDelta = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
    return statusDelta !== 0 ? statusDelta : a.title.localeCompare(b.title)
  })

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
          Review Artifacts
        </div>
        {artifacts.length > 0 ? (
          <span className="text-[11px] font-semibold text-[#5a5a63]">
            {formatArtifactSummary(artifacts)}
          </span>
        ) : null}
      </div>

      {sortedArtifacts.length > 0 ? (
        <div className="divide-y divide-[#1f2025] border-y border-[#1f2025]">
          {sortedArtifacts.map((artifact) => {
            const task = tasksById[artifact.taskId]
            const action = actions[artifact.id]
            const pending = action?.status === 'pending'
            const readyForReview = artifact.status === 'ready_for_review'
            const autoApprovalEligibility = getSwarmArtifactAutoApprovalEligibility(artifact)
            const mobileDecision = getMobileArtifactDecision(artifact)

            return (
              <div key={artifact.id} className="grid gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-[#ececee]">{artifact.title}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ${artifactStatusTone(artifact.status)}`}>
                      {swarmArtifactStatusLabels[artifact.status]}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#5a5a63]">
                    <span>{swarmArtifactKindLabels[artifact.kind]}</span>
                    <button
                      type="button"
                      onClick={() => onSelectTask(artifact.taskId)}
                      disabled={!task}
                      className="font-mono text-[#9a9aa2] transition-colors hover:text-[#ececee] disabled:text-[#5a5a63]"
                    >
                      {artifact.taskId || 'No task'}
                    </button>
                    {task ? <span className="min-w-0 truncate">{task.title}</span> : null}
                  </div>
                  <div className="mt-1 text-[12px] text-[#9a9aa2] [overflow-wrap:anywhere]">
                    {artifact.path || 'No file path recorded.'}
                  </div>
                  {mobileDecision ? (
                    <div className="mt-2 border-l border-[#6ee7d8]/45 pl-2 text-[11px] leading-5 text-[#bff7f1]">
                      {formatMobileArtifactDecision(mobileDecision)}
                    </div>
                  ) : null}
                  {readyForReview && autoApprovalEligibility.label ? (
                    <div className={`mt-2 text-[11px] font-semibold ${
                      autoApprovalEligibility.eligible ? 'text-[#6ee7d8]' : 'text-[#ffd58a]'
                    }`}>
                      {autoApprovalEligibility.label}
                    </div>
                  ) : null}
                  {action && action.status !== 'pending' ? (
                    <div className={`mt-2 border-l pl-2 text-[12px] leading-5 ${
                      action.status === 'error'
                        ? 'border-[#ff1a3d]/60 text-[#ffb3bf]'
                        : 'border-[#30d158]/60 text-[#b9f7c8]'
                    }`}>
                      {action.message}
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <button
                    type="button"
                    onClick={() => onOpenArtifact(artifact)}
                    disabled={pending}
                    className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[#d7d7dc]"
                  >
                    {pending && action?.kind === 'open' ? 'Opening...' : 'Open'}
                  </button>
                  {readyForReview ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onApproveArtifact(artifact)}
                        disabled={pending}
                        className="rounded-md bg-[#6ee7d8]/14 px-3 py-1.5 text-sm font-semibold text-[#d8fffb] transition-colors hover:bg-[#6ee7d8]/20 disabled:opacity-45 disabled:hover:bg-[#6ee7d8]/14"
                      >
                        {pending && action?.kind === 'approve' ? 'Approving...' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRequestArtifactChanges(artifact)}
                        disabled={pending}
                        className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#ff1a3d]/10 hover:text-[#ffb3bf] disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[#d7d7dc]"
                      >
                        {pending && action?.kind === 'requestChanges'
                          ? 'Requesting changes...'
                          : 'Request changes'}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-[12px] text-[#5a5a63]">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

function ArtifactBlockerList({
  blockers,
}: {
  blockers: ReturnType<typeof getSwarmArtifactDependencyBlockers>
}) {
  return (
    <div className="border-l border-[#ffbf2f]/70 pl-3 text-sm text-[#ffe0a3]">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#ffbf2f]">
        Artifact Gate
      </div>
      <div className="mt-2 space-y-2">
        {blockers.map((blocker) => (
          <div key={blocker.taskId}>
            <div className="font-semibold text-[#ffe0a3]">
              {blocker.taskId}: {blocker.title}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {blocker.artifacts.map((artifact) => (
                <span key={artifact.id} className="rounded bg-[#17181d] px-1.5 py-0.5 text-[11px] text-[#d7d7dc]">
                  {artifact.title} - {swarmArtifactStatusLabels[artifact.status]}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not started'
  return new Date(value).toLocaleString()
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

function formatArtifactSummary(artifacts: SwarmArtifact[]): string {
  const pendingCount = artifacts.filter((artifact) =>
    artifact.status !== 'approved' && artifact.status !== 'superseded'
  ).length
  const approvedCount = artifacts.filter((artifact) => artifact.status === 'approved').length

  if (pendingCount > 0 && approvedCount > 0) {
    return `${pendingCount} pending, ${approvedCount} approved`
  }
  if (pendingCount > 0) {
    return `${pendingCount} pending ${pendingCount === 1 ? 'artifact' : 'artifacts'}`
  }
  return `${approvedCount} approved ${approvedCount === 1 ? 'artifact' : 'artifacts'}`
}

function getPrimaryTaskArtifact(artifacts: SwarmArtifact[]): SwarmArtifact | null {
  const statusOrder: SwarmArtifact['status'][] = [
    'ready_for_review',
    'changes_requested',
    'draft',
    'approved',
    'superseded',
  ]

  return [...artifacts]
    .filter((artifact) => artifact.path.trim())
    .sort((a, b) => {
      const statusDelta = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
      return statusDelta !== 0 ? statusDelta : a.title.localeCompare(b.title)
    })[0] ?? null
}

type MobileArtifactDecision = {
  action: string
  actor: string
  timestamp: string | null
  note?: string
}

function getMobileArtifactDecision(artifact: SwarmArtifact): MobileArtifactDecision | null {
  const mobileHistory = [...artifact.reviewHistory]
    .reverse()
    .find((entry) => isMobileActor(entry.actor))

  if (mobileHistory) {
    return {
      action: mobileHistory.action,
      actor: mobileHistory.actor,
      timestamp: mobileHistory.timestamp,
      note: mobileHistory.note,
    }
  }

  if (artifact.approvedBy && isMobileActor(artifact.approvedBy)) {
    return {
      action: 'approved',
      actor: artifact.approvedBy,
      timestamp: artifact.approvedAt ?? null,
    }
  }

  if (artifact.changesRequestedBy && isMobileActor(artifact.changesRequestedBy)) {
    return {
      action: 'changes_requested',
      actor: artifact.changesRequestedBy,
      timestamp: artifact.changesRequestedAt ?? null,
    }
  }

  return null
}

function formatTaskMobileDecisionSummary(artifacts: SwarmArtifact[]): string | null {
  const mobileDecisionCount = artifacts.filter((artifact) => getMobileArtifactDecision(artifact)).length
  if (mobileDecisionCount === 0) return null
  return `${mobileDecisionCount} mobile ${mobileDecisionCount === 1 ? 'decision' : 'decisions'}`
}

function formatMobileArtifactDecision(decision: MobileArtifactDecision): string {
  const parts = [
    `Mobile ${mobileActionLabel(decision.action)} by ${formatMobileActor(decision.actor)}`,
    decision.timestamp ? formatTimestamp(decision.timestamp) : null,
    decision.note,
  ].filter(Boolean)

  return parts.join(' - ')
}

function isMobileActor(actor: string): boolean {
  return actor.trim().toLowerCase().startsWith('mobile:')
}

function formatMobileActor(actor: string): string {
  return actor.replace(/^mobile:/i, '').replace(/[_-]+/g, ' ') || 'mobile device'
}

function mobileActionLabel(action: string): string {
  switch (action) {
    case 'approve':
    case 'approved':
      return 'approved'
    case 'request_changes':
    case 'requestChanges':
    case 'changes_requested':
      return 'requested changes'
    default:
      return action.replace(/[_-]+/g, ' ')
  }
}

function formatArtifactBlockerSummary(
  blockers: ReturnType<typeof getSwarmArtifactDependencyBlockers>
): string {
  const artifactCount = blockers.reduce((total, blocker) => total + blocker.artifacts.length, 0)
  const taskIds = blockers.map((blocker) => blocker.taskId).join(', ')
  return `${artifactCount} ${artifactCount === 1 ? 'artifact' : 'artifacts'} from ${taskIds}`
}

function artifactStatusTone(status: SwarmArtifact['status']): string {
  switch (status) {
    case 'approved':
      return 'bg-[#30d158]/12 text-[#d4ffdc]'
    case 'ready_for_review':
      return 'bg-[#6ee7d8]/12 text-[#bff7f1]'
    case 'changes_requested':
      return 'bg-[#ffbf2f]/14 text-[#ffe0a3]'
    case 'superseded':
      return 'bg-[#1a1b20] text-[#5a5a63]'
    default:
      return 'bg-[#1a1b20] text-[#9a9aa2]'
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
      return 'bg-[#ffbf2f]/14 text-[#ffe0a3]'
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

function SwarmArchitectMergeAction({
  workspaceId,
  workspace,
  swarmState,
  planFilePath,
  repoRoot,
  architectAgentId,
  onStart,
}: {
  workspaceId: string
  workspace: Workspace | null
  swarmState: SwarmState
  planFilePath: string | null
  repoRoot: string | null
  architectAgentId: string | null
  onStart: (eligibility: Extract<SwarmMergeEligibility, { eligible: true }>) => void
}) {
  const setTriggeredKey = useWorkspaceStore((s) => s.setSwarmArchitectMergeAutoTriggeredKey)
  const [eligibility, setEligibility] = useState<SwarmMergeEligibility>({
    eligible: false,
    reason: 'Checking merge eligibility.',
  })

  useEffect(() => {
    let cancelled = false

    async function checkEligibility() {
      const next = await resolveArchitectMergeEligibility({
        workspace,
        swarmState,
        planFilePath,
        repoRoot,
        architectAgentId,
      })
      if (!cancelled) setEligibility(next)
    }

    void checkEligibility()
    return () => {
      cancelled = true
    }
  }, [architectAgentId, planFilePath, repoRoot, swarmState, workspace])

  useEffect(() => {
    if (!eligibility.eligible || !workspace?.swarmAutoState.enabled) return
    if (workspace.swarmAutoState.architectMergeAutoTriggeredKey === eligibility.key) return

    setTriggeredKey(workspaceId, eligibility.key)
    onStart(eligibility)
  }, [eligibility, onStart, setTriggeredKey, workspace?.swarmAutoState.enabled, workspace?.swarmAutoState.architectMergeAutoTriggeredKey, workspaceId])

  if (!eligibility.eligible) return null

  return (
    <button
      onClick={() => onStart(eligibility)}
      className="rounded-md bg-[#d4ffdc] px-3 py-1.5 text-sm font-semibold text-[#08210f] transition-colors hover:bg-[#b9f7c8]"
    >
      Architect Merge to {eligibility.targetBranch}
    </button>
  )
}

async function resolveArchitectMergeEligibility({
  workspace,
  swarmState,
  planFilePath,
  repoRoot,
  architectAgentId,
}: {
  workspace: Workspace | null
  swarmState: SwarmState
  planFilePath: string | null
  repoRoot: string | null
  architectAgentId: string | null
}): Promise<SwarmMergeEligibility> {
  if (!workspace?.swarmAutoState.useWorktreesForSwarms) {
    return { eligible: false, reason: 'Shared sprintengine worktrees are disabled.' }
  }
  if (!architectAgentId) return { eligible: false, reason: 'No architect agent is available.' }
  if (!repoRoot || !planFilePath) return { eligible: false, reason: 'Workspace folder or plan path is unavailable.' }
  if (swarmState.tasks.length === 0 || swarmState.tasks.some((task) => task.status !== 'done')) {
    return { eligible: false, reason: 'SprintEngine tasks are not complete.' }
  }
  if (swarmState.artifacts.some((artifact) =>
    artifact.status !== 'approved' && artifact.status !== 'superseded'
  )) {
    return { eligible: false, reason: 'Review artifacts still need approval or changes.' }
  }

  const planContent = await window.api.readfile(planFilePath).catch(() => '')
  const executionWorkspace = parseExecutionWorkspacePlan(planContent)
  if (!executionWorkspace.worktreeEnabled) {
    return { eligible: false, reason: 'The plan does not declare an enabled worktree.' }
  }
  if (!executionWorkspace.worktreePath) {
    return { eligible: false, reason: 'The plan does not declare a worktree path.' }
  }

  const worktreeExists = await window.api.pathExists(executionWorkspace.worktreePath).catch(() => false)
  if (!worktreeExists) return { eligible: false, reason: 'The declared worktree path is missing.' }

  const listedWorktrees = await window.api.listGitWorktrees(repoRoot).catch(() => null)
  if (!listedWorktrees?.ok) {
    return { eligible: false, reason: listedWorktrees?.message ?? 'Unable to list Git worktrees.' }
  }

  const listedWorktree = listedWorktrees.data.worktrees.find((worktree) =>
    sameFilePath(worktree.path, executionWorkspace.worktreePath ?? '')
  )
  if (!listedWorktree) {
    return { eligible: false, reason: 'The declared worktree is not registered with Git.' }
  }
  if (
    executionWorkspace.branch
    && listedWorktree.branch
    && executionWorkspace.branch !== listedWorktree.branch
  ) {
    return { eligible: false, reason: 'The declared worktree branch does not match Git.' }
  }
  const worktreeBranch = executionWorkspace.branch ?? listedWorktree?.branch ?? null
  if (!worktreeBranch) return { eligible: false, reason: 'The worktree branch is unknown.' }
  if (worktreeBranch === 'main' || worktreeBranch === 'master') {
    return { eligible: false, reason: 'The worktree is already on a protected target branch.' }
  }

  const branchSnapshot = await window.api.getGitBranches(repoRoot).catch(() => null)
  const targetBranch = executionWorkspace.mergeTarget
    ?? branchSnapshot?.branches.find((branch) => branch.name === 'main')?.name
    ?? branchSnapshot?.branches.find((branch) => branch.name === 'master')?.name
    ?? 'main'
  if (targetBranch === worktreeBranch) {
    return { eligible: false, reason: 'The merge target is the same as the worktree branch.' }
  }

  const status = await window.api.getGitStatus(executionWorkspace.worktreePath).catch(() => null)
  if (!status || Object.keys(status.files).length > 0) {
    return { eligible: false, reason: 'The worktree has uncommitted changes.' }
  }

  return {
    eligible: true,
    key: [
      workspace.id,
      planFilePath,
      executionWorkspace.worktreePath,
      worktreeBranch,
      targetBranch,
      swarmState.updatedAt ?? swarmState.tasks.map((task) => task.completedAt ?? task.id).join(','),
    ].join('|'),
    targetBranch,
    worktreePath: executionWorkspace.worktreePath,
    worktreeBranch,
  }
}

function parseExecutionWorkspacePlan(content: string): ExecutionWorkspacePlan {
  const worktreeValue = readPlanLabel(content, 'Worktree')?.toLowerCase() ?? ''
  return {
    worktreeEnabled: worktreeValue === 'enabled',
    worktreePath: readPlanLabel(content, 'Worktree path'),
    branch: readPlanLabel(content, 'Branch'),
    mergeTarget: readPlanLabel(content, 'Merge target'),
  }
}

function readPlanLabel(content: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = content.match(new RegExp(`^${escapedLabel}:\\s*(.+?)\\s*$`, 'im'))
  return match?.[1]?.trim() || null
}

function sameFilePath(firstPath: string, secondPath: string): boolean {
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/u, '')
    return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
  }
  return normalize(firstPath) === normalize(secondPath)
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
  if (!trimmed || trimmed.toLowerCase() === 'launch Sprint Engine mode') {
    return 'Untitled sprintengine run'
  }

  return trimmed
}

function formatSwarmGoalPreview(goal: string): string {
  const formatted = formatSwarmGoal(goal)
  if (formatted === 'Untitled sprintengine run') return formatted

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
    'Run `sprintengine recover` now.',
  ].join('\n')
}

function buildPlanReviewStartupPrompt(role: SwarmRole, agentId: string): string {
  return [
    'Fetch the canonical plan review instructions from the Python tool.',
    `Run \`Sprint Engine plan start-review --role ${role} --id ${agentId}\` now.`,
  ].join('\n')
}

function buildAddressPlanReviewsPrompt(): string {
  return [
    'Fetch the canonical plan review feedback instructions from the Python tool.',
    'Run `Sprint Engine plan address-reviews --actor architect` now.',
  ].join('\n')
}

function buildArchitectMergeStartupPrompt(targetBranch: string, worktreePath: string): string {
  return [
    'Fetch the canonical post-run merge instructions from the Python tool.',
    `Use worktree cwd: \`${worktreePath}\`. If this terminal is not already there, run \`cd ${JSON.stringify(worktreePath)}\` first.`,
    `Run \`sprintengine merge start --id architect --target ${JSON.stringify(targetBranch)}\` now and follow the returned instructions.`,
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
  const feedbackSummaries = buildFeedbackSummary(completed)
  const promptImprovementSignals = buildFeedbackIssueSummary(completed)
  const findingSummaries = buildFeedbackFindingSummary(completed)
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
    feedbackSummaries,
    promptImprovementSignals,
    findingSummaries,
    openQuestions,
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function buildFeedbackSummary(tasks: SwarmTask[]): string[] {
  const feedbackTasks = tasks.filter((task) => task.feedback)
  if (feedbackTasks.length === 0) return []

  return feedbackScoreLabels.flatMap((metric) => {
    const values = feedbackTasks.flatMap((task) => {
      const value = task.feedback?.scores[metric.key]
      return typeof value === 'number' ? [value] : []
    })
    if (values.length === 0) return []
    const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    return [`${metric.label}: ${average}% avg across ${values.length} task${values.length === 1 ? '' : 's'}`]
  })
}

function buildFeedbackIssueSummary(tasks: SwarmTask[]): string[] {
  return tasks.flatMap((task) =>
    (task.feedback?.issues ?? []).map((issue) => {
      const parts = [
        `${task.id}: ${feedbackIssueSeverityLabels[issue.severity]} ${feedbackIssueCategoryLabels[issue.category]}`,
        issue.target ? `target ${issue.target}` : null,
        issue.title,
        issue.suggestedPromptChange ? `Prompt: ${issue.suggestedPromptChange}` : null,
        issue.suggestedProcessChange ? `Process: ${issue.suggestedProcessChange}` : null,
      ].filter(Boolean)
      return parts.join(' - ')
    })
  )
}

function buildFeedbackFindingSummary(tasks: SwarmTask[]): string[] {
  const findings = tasks.flatMap((task) =>
    (task.feedback?.findings ?? []).map((finding) => ({ task, finding }))
  )
  if (findings.length === 0) return []
  const findingRows = findings.map(({ finding }) => finding)

  const total = findings.length
  const severitySummary = summarizeFindingCounts(
    findingRows,
    ['critical', 'high', 'medium', 'low'],
    (finding) => finding.severity,
    feedbackFindingSeverityLabels
  )
  const kindSummary = summarizeFindingCounts(
    findingRows,
    [
      'code_bug',
      'security_issue',
      'product_requirement_violation',
      'test_gap',
      'accessibility_issue',
      'performance_issue',
      'reliability_issue',
      'documentation_gap',
      'other',
    ],
    (finding) => finding.kind,
    feedbackFindingKindLabels
  )
  const areaSummary = summarizeFindingCounts(
    findingRows,
    [
      'frontend',
      'backend',
      'database',
      'networking',
      'auth',
      'security',
      'filesystem',
      'cli',
      'ipc',
      'mobile',
      'testing',
      'docs',
      'product',
      'other',
    ],
    (finding) => finding.area,
    feedbackFindingAreaLabels
  )
  const details = findings.map(({ task, finding }) =>
    `${task.id}: ${feedbackFindingSeverityLabels[finding.severity]} ${feedbackFindingKindLabels[finding.kind]} in ${feedbackFindingAreaLabels[finding.area]} - ${finding.title}`
  )

  return [
    `${total} finding${total === 1 ? '' : 's'} reported`,
    ...(severitySummary ? [`By severity: ${severitySummary}`] : []),
    ...(kindSummary ? [`By type: ${kindSummary}`] : []),
    ...(areaSummary ? [`By area: ${areaSummary}`] : []),
    ...details,
  ]
}

function summarizeFindingCounts<T extends string>(
  findings: SwarmTaskFeedbackFinding[],
  order: readonly T[],
  getValue: (finding: SwarmTaskFeedbackFinding) => T,
  labels: Record<T, string>
): string {
  const counts = new Map<T, number>()
  for (const finding of findings) {
    const value = getValue(finding)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return order.flatMap((key) => {
    const count = counts.get(key) ?? 0
    return count > 0 ? [`${labels[key]} ${count}`] : []
  }).join(', ')
}
