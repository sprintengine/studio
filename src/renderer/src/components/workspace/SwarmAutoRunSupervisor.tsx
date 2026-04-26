import { useEffect, useRef, type MutableRefObject } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, CliRuntimeSettings, SwarmRole, SwarmState, Workspace } from '../../types/workspace'
import { buildSwarmStartupPrompt, prependAgentIdentifier } from '../../utils/agentPrompt'
import {
  buildSwarmAgentRosterForState,
  getSwarmTaskBoardColumn,
  swarmRoleLabels,
} from '../../utils/swarm'
import { parseSwarmStateFile } from '../../utils/swarmStateFile'
import { ensureAgentTabInLayoutModel, focusOrAddAgentTab } from '../../utils/modelRegistry'
import { publishDiagnostic } from '../../utils/diagnostics'

const AUTO_RUN_POLL_MS = 2000
const BACKGROUND_TERMINAL_COLS = 100
const BACKGROUND_TERMINAL_ROWS = 30

function revealAutoRunAgentTerminal(workspaceId: string, agentId: string, label: string): void {
  if (focusOrAddAgentTab(workspaceId, agentId, label)) return

  const state = useWorkspaceStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) return

  try {
    state.updateLayout(
      workspaceId,
      ensureAgentTabInLayoutModel(workspace.layoutModel, agentId, label)
    )
  } catch {
    // The running session remains available in the session manager if the
    // serialized layout cannot be adjusted before the workspace mounts.
  }
}

function isMatchingWorkspaceAgentSession(
  session: TerminalSessionSnapshot,
  workspace: Workspace,
  agentId: string
): boolean {
  return session.running
    && session.kind === 'agent'
    && session.workspaceId === workspace.id
    && session.agentId === agentId
    && (!workspace.swarmContext || session.swarmStatePath === workspace.swarmContext.statePath)
}

async function refreshAutoWorkspaceState(
  workspace: Workspace,
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
): Promise<void> {
  if (!workspace.swarmAutoState.enabled || !workspace.folderPath || !workspace.swarmState || !workspace.swarmContext) return

  const stateFilePath = workspace.swarmContext.statePath

  try {
    const content = await window.api.readfile(stateFilePath)
    if (lastContentByWorkspace.current.get(workspace.id) === content) return

    lastContentByWorkspace.current.set(workspace.id, content)
    useWorkspaceStore.getState().setSwarmState(workspace.id, parseSwarmStateFile(content, workspace.swarmContext.teamSlug))
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

async function agentHasRunningProcess(workspace: Workspace, agentId: string): Promise<boolean> {
  const agent = workspace.agents[agentId]
  const sessions = await window.api.terminalList()
  if (agent?.cliStartRequested && agent.cliHasLaunched && agent.cliSessionId) {
    const storedSession = sessions.find((session) => session.sessionId === agent.cliSessionId)
    if (storedSession && isMatchingWorkspaceAgentSession(storedSession, workspace, agentId)) return true
  }

  const runningSession = sessions.find((session) =>
    isMatchingWorkspaceAgentSession(session, workspace, agentId)
  )

  if (!runningSession) return false

  useWorkspaceStore.getState().updateAgent(workspace.id, agentId, {
    cliSessionId: runningSession.sessionId,
    cliStartRequested: true,
    cliHasLaunched: true,
    cli: runningSession.cli ?? agent?.cli ?? 'codex',
  })
  revealAutoRunAgentTerminal(workspace.id, agentId, agent?.name ?? agentId)
  return true
}

async function pickOrphanedActiveRun(
  workspace: Workspace,
  swarmState: SwarmState
): Promise<{ agentId: string; label: string; role: SwarmRole; taskId: string } | null> {
  const roster = buildSwarmAgentRosterForState(swarmState)
  const rosterById = Object.fromEntries(roster.map((agent) => [agent.id, agent]))
  const activeTasks = swarmState.tasks.filter((task) =>
    task.status === 'in_progress' && Boolean(task.ownerAgentId)
  )

  for (const task of activeTasks) {
    const agentId = task.ownerAgentId
    if (!agentId) continue
    if (await agentHasRunningProcess(workspace, agentId)) return null

    const rosterAgent = rosterById[agentId]
    return {
      agentId,
      label: workspace.agents[agentId]?.name ?? rosterAgent?.label ?? agentId,
      role: rosterAgent?.role ?? task.role,
      taskId: task.id,
    }
  }

  return null
}

async function superviseWorkspace(
  workspace: Workspace,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  inFlightSpawns: MutableRefObject<Set<string>>
): Promise<void> {
  const swarmState = workspace.swarmState
  if (!workspace.swarmAutoState.enabled || !workspace.folderPath || !swarmState || !workspace.swarmContext) return

  const pending = workspace.swarmAutoState.pending
  if (pending) {
    const pendingTask = swarmState.tasks.find((task) => task.id === pending.taskId)
    const pendingTaskStillReady = pendingTask
      ? getSwarmTaskBoardColumn(pendingTask, swarmState.tasks) === 'ready' && !pendingTask.ownerAgentId
      : false
    const pendingAgent = workspace.agents[pending.agentId]
    const pendingAgentHasProcess = await agentHasRunningProcess(workspace, pending.agentId)

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
    return
  }

  if (swarmState.tasks.some((task) => task.status === 'needs_input')) {
    return
  }

  const runningAgents = Object.entries(swarmState.swarmAgents)
    .filter(([, agent]) => agent.status === 'running')
  for (const [agentId] of runningAgents) {
    if (await agentHasRunningProcess(workspace, agentId)) return
  }

  if (swarmState.tasks.length > 0 && swarmState.tasks.every((task) => task.status === 'done')) {
    useWorkspaceStore.getState().setSwarmAutoEnabled(workspace.id, false)
    return
  }

  const nextRun = await pickOrphanedActiveRun(workspace, swarmState)
    ?? pickNextAutoRun(workspace, swarmState)
  if (!nextRun) return
  if (await agentHasRunningProcess(workspace, nextRun.agentId)) return

  const currentState = useWorkspaceStore.getState()
  const currentWorkspace = currentState.workspaces.find((candidate) => candidate.id === workspace.id)
  const currentAgent = currentWorkspace?.agents[nextRun.agentId]
  // Background auto-run needs the startup prompt at process launch. Codex supports
  // that path today; Claude still uses visible-terminal prompt injection.
  const selectedCli: AgentCli = currentAgent?.cli === 'claude' ? 'codex' : currentAgent?.cli ?? 'codex'
  const sessionId = crypto.randomUUID()
  const spawnKey = `${workspace.id}:${nextRun.agentId}`
  if (inFlightSpawns.current.has(spawnKey)) return

  const swarmStatePath = workspace.swarmContext.statePath
  const folderExists = await window.api.pathExists(workspace.folderPath)
  if (!folderExists) {
    currentState.setFolderMissing(workspace.id, true)
    currentState.setSwarmAutoPending(workspace.id, null)
    currentState.setSwarmAutoEnabled(workspace.id, false)
    await publishDiagnostic({
      level: 'error',
      source: 'filesystem',
      title: 'Auto-run stopped',
      message: `Workspace folder could not be found: ${workspace.folderPath}`,
      details: [
        `Workspace: ${workspace.name}`,
        `Agent: ${nextRun.agentId}`,
        `Task: ${nextRun.taskId}`,
      ].join('\n'),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      agentId: nextRun.agentId,
      taskId: nextRun.taskId,
    })
    return
  }

  const startupPrompt = prependAgentIdentifier(
    buildSwarmStartupPrompt(nextRun.role, nextRun.agentId, swarmState.goal),
    nextRun.label,
    swarmRoleLabels[nextRun.role]
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
    const spawnResult = await window.api.terminalSpawn(
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
    ).catch((error): TerminalSpawnResult => ({
      ok: false,
      sessionId,
      message: error instanceof Error ? error.message : 'Failed to start terminal.',
      exitCode: 1,
    }))
    if (!spawnResult.ok) {
      const latestState = useWorkspaceStore.getState()
      latestState.setSwarmAutoEnabled(workspace.id, false)
      latestState.setSwarmAutoPending(workspace.id, null)
      latestState.updateAgent(workspace.id, nextRun.agentId, {
        cliStartRequested: true,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
      })
      await publishDiagnostic({
        level: 'error',
        source: 'terminal',
        title: `${nextRun.label} was not started`,
        message: spawnResult.message,
        details: [
          `Workspace: ${workspace.name}`,
          `CLI: ${selectedCli}`,
          `Task: ${nextRun.taskId}`,
          `Session: ${sessionId}`,
          `Swarm state: ${swarmStatePath}`,
        ].join('\n'),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: nextRun.agentId,
        taskId: nextRun.taskId,
        sessionId,
      })
      revealAutoRunAgentTerminal(workspace.id, nextRun.agentId, nextRun.label)
      return
    }

    revealAutoRunAgentTerminal(workspace.id, nextRun.agentId, nextRun.label)
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
