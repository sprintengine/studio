import { useEffect, useRef, type MutableRefObject } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, CliRuntimeSettings, SwarmRole, SwarmState, Workspace } from '../../types/workspace'
import { buildSwarmStartupPrompt, prependAgentIdentifier } from '../../utils/agentPrompt'
import {
  buildSwarmAgentRosterForState,
  getSwarmTaskBoardColumn,
  swarmRoleLabels,
} from '../../utils/swarm'
import {
  getExistingSwarmStateFilePath,
  getSwarmRootDirectoryPath,
  getSwarmStateFilePath,
  parseSwarmStateFile,
} from '../../utils/swarmStateFile'

const AUTO_RUN_POLL_MS = 2000
const BACKGROUND_TERMINAL_COLS = 100
const BACKGROUND_TERMINAL_ROWS = 30

async function resolveReadableSwarmStatePath(
  folderPath: string,
  swarmName: string
): Promise<string> {
  const preferredPath = getSwarmStateFilePath(folderPath, swarmName)
  if (await window.api.pathExists(preferredPath)) return preferredPath

  const swarmRootDirectory = getSwarmRootDirectoryPath(folderPath)
  try {
    const entries = await window.api.readdir(swarmRootDirectory)
    const existingStatePaths = await Promise.all(
      entries
        .filter((entry) => entry.isDir)
        .map(async (entry) => {
          const statePath = getExistingSwarmStateFilePath(folderPath, entry.name)
          return await window.api.pathExists(statePath) ? statePath : null
        })
    )
    const statePaths = existingStatePaths.filter((path): path is string => Boolean(path))
    if (statePaths.length === 1) return statePaths[0]
  } catch {
    // The swarm directory may not exist yet.
  }

  return preferredPath
}

async function refreshAutoWorkspaceState(
  workspace: Workspace,
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
): Promise<void> {
  if (!workspace.swarmAutoState.enabled || !workspace.folderPath || !workspace.swarmState) return

  const swarmName = workspace.swarmState.name || workspace.name
  const stateFilePath = await resolveReadableSwarmStatePath(workspace.folderPath, swarmName)

  try {
    const content = await window.api.readfile(stateFilePath)
    if (lastContentByWorkspace.current.get(workspace.id) === content) return

    lastContentByWorkspace.current.set(workspace.id, content)
    useWorkspaceStore.getState().setSwarmState(workspace.id, parseSwarmStateFile(content))
  } catch {
    // Auto mode can be enabled before the agent-managed state file exists.
  }
}

function pickNextAutoRun(
  workspace: Workspace,
  swarmState: SwarmState
): { agentId: string; label: string; role: SwarmRole; taskId: string } | null {
  const roster = buildSwarmAgentRosterForState(swarmState)
  const runtimeAgentById = Object.fromEntries(
    roster.map((agent) => [
      agent.id,
      {
        role: swarmState.swarmAgents[agent.id]?.role ?? agent.role,
        status: swarmState.swarmAgents[agent.id]?.status ?? 'idle',
      },
    ])
  )
  const readyTasks = swarmState.tasks.filter((task) =>
    getSwarmTaskBoardColumn(task, swarmState.tasks) === 'ready'
  )
  const nextTask = readyTasks.find((task) => !task.ownerAgentId)
  if (!nextTask) return null

  const existingAgent = roster.find((agent) =>
    agent.role === nextTask.role
    && runtimeAgentById[agent.id]?.status !== 'done'
    && !workspace.agents[agent.id]?.cliStartRequested
  )
  const agent = existingAgent
    ?? useWorkspaceStore.getState().addSwarmMember(workspace.id, nextTask.role)

  if (!agent) return null

  return {
    agentId: agent.id,
    label: workspace.agents[agent.id]?.name ?? agent.label,
    role: nextTask.role,
    taskId: nextTask.id,
  }
}

async function superviseWorkspace(
  workspace: Workspace,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  inFlightSpawns: MutableRefObject<Set<string>>
): Promise<void> {
  const swarmState = workspace.swarmState
  if (!workspace.swarmAutoState.enabled || !workspace.folderPath || !swarmState) return

  const pending = workspace.swarmAutoState.pending
  if (pending) {
    const pendingTask = swarmState.tasks.find((task) => task.id === pending.taskId)
    const pendingTaskStillReady = pendingTask
      ? getSwarmTaskBoardColumn(pendingTask, swarmState.tasks) === 'ready' && !pendingTask.ownerAgentId
      : false
    const pendingAgent = workspace.agents[pending.agentId]
    const pendingAgentHasProcess =
      pendingAgent?.cliStartRequested && pendingAgent.cliHasLaunched && pendingAgent.cliSessionId
        ? (await window.api.terminalStatus(pendingAgent.cliSessionId)).running
        : false

    if (pendingTaskStillReady && pendingAgentHasProcess) return
    if (pendingAgent && pendingAgent.cliStartRequested && !pendingAgentHasProcess) {
      useWorkspaceStore.getState().updateAgent(workspace.id, pending.agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
      })
    }
    useWorkspaceStore.getState().setSwarmAutoPending(workspace.id, null)
  }

  const runtimeAgents = Object.values(swarmState.swarmAgents)
  if (runtimeAgents.some((agent) => agent.status === 'needs_input')) {
    useWorkspaceStore.getState().setSwarmAutoEnabled(workspace.id, false)
    return
  }

  if (runtimeAgents.some((agent) => agent.status === 'running')) return

  if (swarmState.tasks.length > 0 && swarmState.tasks.every((task) => task.status === 'done')) {
    useWorkspaceStore.getState().setSwarmAutoEnabled(workspace.id, false)
    return
  }

  const nextRun = pickNextAutoRun(workspace, swarmState)
  if (!nextRun) return

  const currentState = useWorkspaceStore.getState()
  const currentWorkspace = currentState.workspaces.find((candidate) => candidate.id === workspace.id)
  const currentAgent = currentWorkspace?.agents[nextRun.agentId]
  // Background auto-run needs the startup prompt at process launch. Codex supports
  // that path today; Claude still uses visible-terminal prompt injection.
  const selectedCli: AgentCli = currentAgent?.cli === 'claude' ? 'codex' : currentAgent?.cli ?? 'codex'
  const sessionId = crypto.randomUUID()
  const spawnKey = `${workspace.id}:${nextRun.agentId}`
  if (inFlightSpawns.current.has(spawnKey)) return

  const startupPrompt = prependAgentIdentifier(
    buildSwarmStartupPrompt(nextRun.role, nextRun.agentId, swarmState.goal),
    nextRun.label,
    swarmRoleLabels[nextRun.role]
  )
  const swarmStatePath = await resolveReadableSwarmStatePath(
    workspace.folderPath,
    swarmState.name || workspace.name
  )

  inFlightSpawns.current.add(spawnKey)
  currentState.setSwarmAutoPending(workspace.id, {
    taskId: nextRun.taskId,
    agentId: nextRun.agentId,
  })
  currentState.updateAgent(workspace.id, nextRun.agentId, {
    name: nextRun.label,
    cliStartRequested: true,
    cliSessionId: sessionId,
    cliHasLaunched: true,
    cliOnboardingPromptSent: selectedCli === 'codex',
    cli: selectedCli,
    cliStartupPrompt: selectedCli === 'codex' ? undefined : startupPrompt,
  })

  try {
    await window.api.terminalSpawn(
      sessionId,
      BACKGROUND_TERMINAL_COLS,
      BACKGROUND_TERMINAL_ROWS,
      workspace.folderPath,
      false,
      swarmStatePath,
      selectedCli,
      selectedCli === 'codex' ? startupPrompt : undefined,
      cliRuntimes,
      false,
      {
        kind: 'agent',
        workspaceId: workspace.id,
        agentId: nextRun.agentId,
      }
    )
  } finally {
    inFlightSpawns.current.delete(spawnKey)
  }
}

async function reconcileWorkspaceSessions(workspace: Workspace): Promise<void> {
  for (const agent of Object.values(workspace.agents)) {
    if (!agent.cliStartRequested || !agent.cliHasLaunched || !agent.cliSessionId) continue

    const status = await window.api.terminalStatus(agent.cliSessionId)
    if (status.running) continue

    useWorkspaceStore.getState().updateAgent(workspace.id, agent.id, {
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
    })
  }
}

export default function SwarmAutoRunSupervisor() {
  const inFlightSpawns = useRef(new Set<string>())
  const lastContentByWorkspace = useRef(new Map<string, string>())
  const tickInProgress = useRef(false)

  useEffect(() => {
    let disposed = false

    const tick = async () => {
      if (tickInProgress.current) return
      tickInProgress.current = true

      try {
        const { workspaces, appSettings } = useWorkspaceStore.getState()
        const autoWorkspaces = workspaces.filter((workspace) => workspace.swarmAutoState.enabled)

        for (const workspace of autoWorkspaces) {
          if (disposed) return
          await refreshAutoWorkspaceState(workspace, lastContentByWorkspace)
        }

        const refreshedState = useWorkspaceStore.getState()
        for (const workspace of refreshedState.workspaces) {
          if (disposed) return
          await reconcileWorkspaceSessions(workspace)
        }

        const reconciledState = useWorkspaceStore.getState()
        for (const workspace of reconciledState.workspaces) {
          if (disposed) return
          await superviseWorkspace(workspace, appSettings.cliRuntimes, inFlightSpawns)
        }
      } finally {
        tickInProgress.current = false
      }
    }

    void tick()
    const interval = window.setInterval(() => {
      void tick()
    }, AUTO_RUN_POLL_MS)

    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [])

  return null
}
