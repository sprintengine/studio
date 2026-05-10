import { useEffect, useRef, type MutableRefObject } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  CliRuntimeSettings,
  MultiloopAutoPendingSpawn,
  MultiloopState,
  SprintEngineState,
  Workspace,
} from '../../types/workspace'
import { loadMultiloopPrompt } from '../../specialists/specialistActions'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnostic } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { ensureAgentTabInLayoutModel, focusOrAddAgentTab } from '../../utils/modelRegistry'
import { parseMultiloopStateFile } from '../../utils/multiloopStateFile'
import { getActiveMultiloopMilestone } from '../../utils/multiloop'
import { parseSprintEngineStateFile } from '../../utils/sprintengineStateFile'
import { buildSprintEngineRosterCommandArgs, sprintEngineRoleLabels } from '../../utils/sprintengine'
import {
  buildMultiloopAutoStartupPrompt,
  selectMultiloopAutoRunCandidates,
  type MultiloopAutoRunCandidate,
} from '../../utils/multiloopAutoRun'

const AUTO_RUN_POLL_MS = 2000
const INACTIVE_AUTO_RUN_POLL_MS = 15000
const AUTO_RUN_STARTUP_SPAWN_DELAY_MS = 5000
const AUTO_RUN_PENDING_SPAWN_GRACE_MS = 60000
const TERMINAL_IPC_TIMEOUT_MS = 3000
const BACKGROUND_TERMINAL_COLS = 100
const BACKGROUND_TERMINAL_ROWS = 30

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

function revealMultiloopAgentTerminal(workspaceId: string, agentId: string, label: string): void {
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
    // The terminal session remains available even if layout persistence is busy.
  }
}

function isMatchingMultiloopAutoRunSession(
  session: TerminalSessionSnapshot,
  workspace: Workspace,
  agentId: string
): boolean {
  return Boolean(
    session.running
    && session.kind === 'agent'
    && session.workspaceId === workspace.id
    && session.agentId === agentId
  )
}

function resolveProjectPath(path: string, workspaceRoot: string): string {
  if (/^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return path
  const sep = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/'
  return `${workspaceRoot.replace(/[\\/]+$/u, '')}${sep}${path.replace(/^[\\/]+/u, '')}`
}

async function listTerminalSessionsForMultiloopAutoRun(
  workspace: Workspace,
  cause: string
): Promise<TerminalSessionSnapshot[]> {
  try {
    const sessions = await withTimeout(
      window.api.terminalList(),
      TERMINAL_IPC_TIMEOUT_MS,
      `Timed out waiting for terminal sessions after ${TERMINAL_IPC_TIMEOUT_MS}ms.`
    )
    logPerfEvent('MultiloopAutoRun', 'terminal-list', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      sessionCount: sessions.length,
    })
    return sessions
  } catch (error) {
    logPerfEvent('MultiloopAutoRun', 'terminal-list-error', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cause,
      message: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

async function refreshMultiloopWorkspaceState(
  workspace: Workspace,
  lastContentByWorkspace: MutableRefObject<Map<string, string>>,
  options: { force?: boolean } = {}
): Promise<MultiloopState | null> {
  if (!workspace.folderPath || !workspace.multiloopState || !workspace.multiloopContext) return null

  try {
    const content = await window.api.readfile(workspace.multiloopContext.statePath)
    if (!options.force && lastContentByWorkspace.current.get(workspace.id) === content) {
      return workspace.multiloopState
    }

    lastContentByWorkspace.current.set(workspace.id, content)
    const parsed = parseMultiloopStateFile(content)
    if (!parsed.ok) {
      await publishDiagnostic({
        level: 'warning',
        source: 'workspace',
        title: 'Multiloop auto-run skipped this tick',
        message: parsed.error.message,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      })
      return null
    }

    useWorkspaceStore.getState().setMultiloopState(workspace.id, parsed.state)
    return parsed.state
  } catch {
    return null
  }
}

async function readLinkedSprintEngineState(
  workspace: Workspace,
  multiloopState: MultiloopState
): Promise<SprintEngineState | null> {
  if (!workspace.folderPath) return null
  const activeMilestone = getActiveMultiloopMilestone(multiloopState)
  const link = activeMilestone?.sprintEngine
  if (!link) return null

  try {
    const content = await window.api.readfile(resolveProjectPath(link.statePath, workspace.folderPath))
    return parseSprintEngineStateFile(content, link.teamSlug)
  } catch (error) {
    await publishDiagnostic({
      level: 'warning',
      source: 'sprintengine',
      title: 'Multiloop auto-run skipped linked Sprint Engine state',
      message: error instanceof Error ? error.message : String(error),
      details: [
        `Workspace: ${workspace.name}`,
        `Sprint Engine state: ${link.statePath}`,
      ].join('\n'),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    })
    return null
  }
}

async function reconcileWorkspaceSessions(workspace: Workspace): Promise<void> {
  for (const agent of Object.values(workspace.agents)) {
    if (!['multiloop', 'sprintengine'].includes(agent.kind ?? '') || !agent.cliStartRequested || !agent.cliHasLaunched || !agent.cliSessionId) continue

    const status = await window.api.terminalStatus(agent.cliSessionId)
    if (status.running) continue

    useWorkspaceStore.getState().updateAgent(workspace.id, agent.id, {
      cliSessionId: undefined,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: (agent.cli ?? 'codex') === 'codex' ? agent.cliResumeAvailable ?? true : false,
    })
  }
}

async function getRunningMultiloopAgentIds(workspace: Workspace): Promise<Set<string>> {
  const sessions = await listTerminalSessionsForMultiloopAutoRun(workspace, 'running-agents')
  return new Set(
    sessions
      .filter((session) =>
        typeof session.agentId === 'string'
        && isMatchingMultiloopAutoRunSession(session, workspace, session.agentId)
      )
      .map((session) => session.agentId!)
  )
}

async function reconcileMultiloopAutoPendingSpawns(
  workspace: Workspace,
  runningAgentIds: Set<string>
): Promise<MultiloopAutoPendingSpawn[]> {
  const pendingSpawns = workspace.multiloopAutoState.pendingSpawns
  if (pendingSpawns.length === 0) return []

  const now = Date.now()
  const activePendingSpawns = pendingSpawns.filter((pending) =>
    runningAgentIds.has(pending.agentId)
    || now - (pending.startedAt ?? 0) < AUTO_RUN_PENDING_SPAWN_GRACE_MS
  )

  if (activePendingSpawns.length !== pendingSpawns.length) {
    useWorkspaceStore.getState().setMultiloopAutoPendingSpawns(workspace.id, activePendingSpawns)
  }

  return activePendingSpawns
}

async function spawnMultiloopAutoRunCandidate(
  workspace: Workspace,
  multiloopState: MultiloopState,
  linkedSprintEngineState: SprintEngineState | null,
  candidate: MultiloopAutoRunCandidate,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  inFlightSpawns: MutableRefObject<Set<string>>
): Promise<'started' | 'failed' | 'skipped'> {
  const spawnKey = `${workspace.id}:${candidate.agentId}`
  if (inFlightSpawns.current.has(spawnKey)) return 'skipped'
  if (!workspace.folderPath || !workspace.multiloopContext) return 'skipped'

  const currentState = useWorkspaceStore.getState()
  const currentWorkspace = currentState.workspaces.find((item) => item.id === workspace.id)
  const currentAgent = currentWorkspace?.agents[candidate.agentId]
  const selectedCli: AgentCli = currentAgent?.cli ?? 'codex'
  const sessionId = crypto.randomUUID()

  inFlightSpawns.current.add(spawnKey)
  try {
    const folderExists = await window.api.pathExists(workspace.folderPath)
    if (!folderExists) {
      currentState.setFolderMissing(workspace.id, true)
      currentState.setMultiloopAutoEnabled(workspace.id, false)
      currentState.setMultiloopAutoPendingSpawns(workspace.id, [])
      await publishDiagnostic({
        level: 'error',
        source: 'filesystem',
        title: 'Multiloop auto-run stopped',
        message: `Workspace folder could not be found: ${workspace.folderPath}`,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: candidate.agentId,
        taskId: candidate.taskId ?? undefined,
      })
      return 'failed'
    }

    if (currentAgent?.cliStartRequested && currentAgent.cliSessionId) return 'skipped'

    const activeMilestone = getActiveMultiloopMilestone(multiloopState)
    const linkedStatePath = activeMilestone?.sprintEngine
      ? resolveProjectPath(activeMilestone.sprintEngine.statePath, workspace.folderPath)
      : null
    let startupPrompt: string
    if (candidate.kind === 'sprintengine-task') {
      if (!linkedSprintEngineState || !activeMilestone?.sprintEngine || !linkedStatePath) return 'skipped'
      startupPrompt = prependAgentIdentifier(
        buildSprintEngineStartupPrompt(candidate.role, candidate.agentId, linkedSprintEngineState.goal, {
          executionCwd: workspace.folderPath,
          workspaceRoot: workspace.folderPath,
          sprintEngineStatePath: activeMilestone.sprintEngine.statePath,
          rosterArgs: buildSprintEngineRosterCommandArgs(linkedSprintEngineState),
          commandMode: getSprintEngineStartupCommandMode(candidate.role, candidate.agentId, linkedSprintEngineState),
        }),
        candidate.label,
        sprintEngineRoleLabels[candidate.role]
      )
    } else {
      const repaired = await window.api.initializeMultiloopState({
        workspaceRoot: workspace.folderPath,
        loopName: multiloopState.loop.displayName,
        finalGoal: multiloopState.loop.finalGoal,
      })
      if (!repaired.ok) {
        currentState.setMultiloopAutoEnabled(workspace.id, false)
        await publishDiagnostic({
          level: 'error',
          source: 'workspace',
          title: 'Multiloop CLI unavailable',
          message: repaired.message || 'Could not prepare the Multiloop CLI wrapper for this workspace.',
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          agentId: candidate.agentId,
          taskId: candidate.taskId ?? undefined,
        })
        return 'failed'
      }

      const multiloopPrompt = await loadMultiloopPrompt(candidate.role)
      startupPrompt = prependAgentIdentifier(
        buildMultiloopAutoStartupPrompt({
          multiloopPrompt,
          role: candidate.role,
          state: multiloopState,
          statePath: workspace.multiloopContext.statePath,
          workspaceRoot: workspace.folderPath,
          agentId: candidate.agentId,
          coordinatorReviewContext: candidate.kind === 'coordinator',
        }),
        candidate.label,
        `Multiloop ${candidate.label}`
      )
    }
    const pendingSpawn: MultiloopAutoPendingSpawn = {
      role: candidate.role,
      taskId: candidate.taskId,
      agentId: candidate.agentId,
      startedAt: Date.now(),
    }

    currentState.setMultiloopAutoPendingSpawns(workspace.id, [
      ...workspace.multiloopAutoState.pendingSpawns,
      pendingSpawn,
    ])
    currentState.updateAgent(workspace.id, candidate.agentId, {
      name: candidate.label,
      execution: {
        mode: 'current_workspace',
        worktreeId: null,
        cwd: null,
      },
      cliStartRequested: true,
      cliSessionId: sessionId,
      cliHasLaunched: true,
      cliOnboardingPromptSent: true,
      cliResumeAvailable: selectedCli === 'codex',
      cli: selectedCli,
      cliPermissionPreset: workspace.multiloopAutoState.cliPermissionPreset,
      cliStartupPrompt: undefined,
      kind: candidate.kind === 'sprintengine-task' ? 'sprintengine' : 'multiloop',
      specialistId: undefined,
      multiloopRole: candidate.kind === 'sprintengine-task' ? undefined : candidate.role,
    })

    const memoryRelativeRoot = workspace.memory.relativeRoot
    const memoryStatus = memoryRelativeRoot
      ? await window.api.memoryResolveRoot({
        workspaceRoot: workspace.folderPath,
        relativeRoot: memoryRelativeRoot,
      }).catch((): MemoryRootStatus => ({
        ok: false,
        status: 'inaccessible',
        relativeRoot: memoryRelativeRoot,
        message: 'Unable to resolve workspace memory.',
      }))
      : null
    const memoryPrompt = memoryStatus
      ? memoryStatus.ok
        ? [
          `Workspace memory is configured at ${memoryStatus.relativeRoot}.`,
          'This is a local Markdown knowledge graph for product, architecture, brand, and ecosystem context.',
          'Inspect it when relevant instead of assuming project context.',
          'Use the workspace-memory skill if it is installed in .agents/skills.',
        ].join(' ')
        : `Workspace memory is configured at ${memoryRelativeRoot}, but the folder is currently missing or inaccessible. Do not guess another memory folder.`
      : null
    const launchPrompt = [startupPrompt, memoryPrompt].filter(Boolean).join('\n\n')

    const spawnResult = await window.api.terminalSpawn(
      sessionId,
      BACKGROUND_TERMINAL_COLS,
      BACKGROUND_TERMINAL_ROWS,
      workspace.folderPath,
      false,
      candidate.kind === 'sprintengine-task' ? linkedStatePath ?? undefined : undefined,
      selectedCli,
      launchPrompt,
      cliRuntimes,
      false,
      {
        kind: 'agent',
        workspaceId: workspace.id,
        agentId: candidate.agentId,
        ...(candidate.kind === 'sprintengine-task' && linkedStatePath ? { sprintEngineStatePath: linkedStatePath } : {}),
        cliPermissionPreset: workspace.multiloopAutoState.cliPermissionPreset,
        memoryRootPath: memoryStatus?.ok ? memoryStatus.rootPath : undefined,
        memoryRelativeRoot: memoryRelativeRoot ?? undefined,
      }
    ).catch((error): TerminalSpawnResult => ({
      ok: false,
      sessionId,
      message: error instanceof Error ? error.message : 'Failed to start terminal.',
      exitCode: 1,
    }))

    if (!spawnResult.ok) {
      const latestState = useWorkspaceStore.getState()
      latestState.setMultiloopAutoEnabled(workspace.id, false)
      latestState.setMultiloopAutoPendingSpawns(workspace.id, [])
      latestState.updateAgent(workspace.id, candidate.agentId, {
        cliStartRequested: true,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliResumeAvailable: false,
      })
      await publishDiagnostic({
        level: 'error',
        source: 'terminal',
        title: `${candidate.label} was not started`,
        message: spawnResult.message,
        details: [
          `Workspace: ${workspace.name}`,
          `CLI: ${selectedCli}`,
          `CLI permissions: ${workspace.multiloopAutoState.cliPermissionPreset}`,
          candidate.taskId ? `Task: ${candidate.taskId}` : 'Task: milestone coordination',
          `Session: ${sessionId}`,
          `Cwd: ${workspace.folderPath}`,
          candidate.kind === 'sprintengine-task'
            ? `Sprint Engine state: ${linkedStatePath ?? 'Unavailable'}`
            : `Multiloop state: ${workspace.multiloopContext.statePath}`,
        ].join('\n'),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        agentId: candidate.agentId,
        taskId: candidate.taskId ?? undefined,
        sessionId,
      })
      revealMultiloopAgentTerminal(workspace.id, candidate.agentId, candidate.label)
      return 'failed'
    }

    revealMultiloopAgentTerminal(workspace.id, candidate.agentId, candidate.label)
    return 'started'
  } finally {
    inFlightSpawns.current.delete(spawnKey)
  }
}

async function superviseWorkspace(
  workspace: Workspace,
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>,
  inFlightSpawns: MutableRefObject<Set<string>>,
  lastContentByWorkspace: MutableRefObject<Map<string, string>>
): Promise<void> {
  let multiloopState = workspace.multiloopState
  if (!workspace.multiloopAutoState.enabled || !workspace.folderPath || !multiloopState || !workspace.multiloopContext) return

  const refreshedState = await refreshMultiloopWorkspaceState(workspace, lastContentByWorkspace)
  if (refreshedState) multiloopState = refreshedState

  await reconcileWorkspaceSessions(workspace)
  const latestWorkspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
  if (!latestWorkspace?.multiloopAutoState.enabled || !latestWorkspace.multiloopState) return
  workspace = latestWorkspace
  multiloopState = latestWorkspace.multiloopState

  const linkedSprintEngineState = await readLinkedSprintEngineState(workspace, multiloopState)
  const runningAgentIds = await getRunningMultiloopAgentIds(workspace)
  const pendingSpawns = await reconcileMultiloopAutoPendingSpawns(workspace, runningAgentIds)
  const inFlightAgentIds = new Set(
    [...inFlightSpawns.current]
      .filter((key) => key.startsWith(`${workspace.id}:`))
      .map((key) => key.slice(workspace.id.length + 1))
  )
  const occupiedCount = new Set([
    ...runningAgentIds,
    ...pendingSpawns.map((pending) => pending.agentId),
    ...inFlightAgentIds,
  ]).size
  const availableSlots = Math.max(0, workspace.multiloopAutoState.maxConcurrentAgents - occupiedCount)
  const selection = selectMultiloopAutoRunCandidates({
    state: multiloopState,
    limit: availableSlots,
    runningAgentIds,
    pendingSpawns,
    inFlightAgentIds,
    coordinatorAutoSpawnKey: workspace.multiloopAutoState.coordinatorAutoSpawnKey,
    linkedSprintEngineState,
  })

  logPerfEvent('MultiloopAutoRun', 'selection', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    reason: selection.reason,
    candidateCount: selection.candidates.length,
    skippedUnknownRoles: selection.skippedUnknownRoles,
  })

  for (const candidate of selection.candidates) {
    const latest = useWorkspaceStore.getState().workspaces.find((item) => item.id === workspace.id)
    if (!latest?.multiloopAutoState.enabled) return
    const result = await spawnMultiloopAutoRunCandidate(latest, multiloopState, linkedSprintEngineState, candidate, cliRuntimes, inFlightSpawns)
    if (result === 'started' && candidate.kind === 'coordinator') {
      const activeMilestoneId = getActiveMultiloopMilestone(multiloopState)?.id ?? null
      if (activeMilestoneId) {
        useWorkspaceStore.getState().setMultiloopCoordinatorAutoSpawnKey(workspace.id, activeMilestoneId)
      }
    }
    if (result === 'failed') return
  }
}

export default function MultiloopAutoRunSupervisor() {
  const inFlightSpawns = useRef(new Set<string>())
  const lastContentByWorkspace = useRef(new Map<string, string>())
  const lastInactiveTickByWorkspace = useRef(new Map<string, number>())
  const startedAt = useRef(Date.now())
  const tickInProgress = useRef(false)

  useEffect(() => {
    let disposed = false

    const tick = async () => {
      if (tickInProgress.current) return
      tickInProgress.current = true

      try {
        const { workspaces, appSettings, activeWorkspaceId } = useWorkspaceStore.getState()
        const now = Date.now()
        const autoWorkspaces = workspaces
          .filter((workspace) => workspace.mode === 'multiloop' && workspace.multiloopAutoState.enabled)
          .filter((workspace) => {
            if (workspace.id === activeWorkspaceId) return true

            const lastTick = lastInactiveTickByWorkspace.current.get(workspace.id) ?? 0
            if (now - lastTick < INACTIVE_AUTO_RUN_POLL_MS) return false
            lastInactiveTickByWorkspace.current.set(workspace.id, now)
            return true
          })

        const startupSpawnDelayElapsed = Date.now() - startedAt.current >= AUTO_RUN_STARTUP_SPAWN_DELAY_MS
        for (const workspace of autoWorkspaces) {
          if (disposed || !startupSpawnDelayElapsed) return
          await superviseWorkspace(workspace, appSettings.cliRuntimes, inFlightSpawns, lastContentByWorkspace)
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
