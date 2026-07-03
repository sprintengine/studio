import type { Dispatch, SetStateAction } from 'react'
import type {
  AgentCli,
  AgentExecution,
  AgentState,
  SprintEngineState,
  Workspace,
  WorkspaceId,
} from '../../../types/workspace'
import { addAgentTabTiled, focusOrAddAgentTab, hasAgentTab } from '../../../utils/modelRegistry'
import { agentCliSupportsConversationResume } from '../../../utils/agentCliResume'
import { getSprintEngineRoleLabel, shouldResumeRecordedRosterSession, type SprintEngineAgentRosterItem } from '../../../utils/sprintengine'
import { prependAgentIdentifier } from '../../../utils/agentPrompt'
import { publishDiagnostic } from '../../../utils/diagnostics'
import {
  buildSprintEngineAddressPlanReviewsPrompt,
  buildSprintEnginePlanReviewStartupPrompt,
  buildSprintEngineRecoveryAuditPrompt,
} from '../../../utils/sprintenginePlanReviewPrompts'

type RecoveryDialogState = {
  cli: AgentCli
  model?: string
}

type StartAgentTerminalOptions = {
  startupPrompt?: string
  freshSession?: boolean
  agentName?: string
  execution?: AgentExecution
  // Resume a specific recorded CLI session instead of minting a fresh one — used
  // to re-open a completed run's roster agent and continue its conversation.
  // `resumeSessionId` is the stable terminal/claude id; `resumeHarnessSessionId`
  // is the codex harness token when the recorded CLI resumes with its own id.
  resumeSessionId?: string
  resumeHarnessSessionId?: string
  // string sets the launch model, null clears it back to the CLI default,
  // undefined preserves whatever the agent already has.
  cliModel?: string | null
  // 'foreground' (default) reveals + focuses the agent tab — right for an
  // explicit "open this agent" click. 'background' docks the tab without
  // stealing focus, so automatic launches (initial spawn on Sprint Engine
  // start, pending respawns) don't yank the user off the board.
  reveal?: 'foreground' | 'background'
}

export type SprintEngineBoardTerminalActionsInput = {
  workspaceId: WorkspaceId
  workspace: Workspace | null | undefined
  agents: Record<string, AgentState>
  sprintEngineState: SprintEngineState | null | undefined
  rosterById: Record<string, SprintEngineAgentRosterItem | undefined>
  architectAgentId: string | null
  specialistReviewAgents: SprintEngineAgentRosterItem[]
  savedFolderPath: string | null
  folderPath: string | null
  folderStatusMessage: string | null
  folderCheckedPath: string | null
  lastSelectedCli: AgentCli
  recoveryDialog: RecoveryDialogState | null
  updateAgent: (workspaceId: WorkspaceId, agentId: string, update: Partial<AgentState>) => void
  recheckFolder: () => void
  setSelectedAgentId: Dispatch<SetStateAction<string | null>>
  setCliPickerOpen: Dispatch<SetStateAction<boolean>>
  setRecoveryDialog: Dispatch<SetStateAction<RecoveryDialogState | null>>
  getAgentName: (agentId: string, fallback: string) => string
  getCustomAgentName: (agentId: string, fallback: string) => string | undefined
  getLiveAgentTerminalSession: (agentId: string) => TerminalSessionSnapshot | null | undefined
}

export type SprintEngineBoardTerminalActions = {
  startAgentTerminal: (
    agentId: string,
    label: string,
    cli?: AgentCli,
    options?: StartAgentTerminalOptions,
  ) => boolean
  startAgentTerminalWhenReady: (
    agentId: string,
    label: string,
    cli?: AgentCli,
    options?: StartAgentTerminalOptions,
  ) => Promise<boolean>
  ensureWorkspaceFolderReadyForLaunch: (agentId: string, label: string) => Promise<boolean>
  openAgentTerminal: (agentId: string) => void
  // Kills the live app-owned terminal process and clears local launch flags.
  // Canonical roster membership is untouched; the main-process teardown sends
  // sprintengine.agent.leave so owned claims are released.
  stopAgentTerminal: (agentId: string) => Promise<boolean>
  // Kills any live terminal, then starts a fresh session with the agent's
  // current CLI/model selection.
  restartAgentTerminal: (agentId: string) => Promise<boolean>
  // Spawns the agent's terminal directly with its resolved CLI/model
  // defaults. If a live terminal already exists, focuses it instead of
  // re-spawning.
  spawnAgent: (agentId: string) => Promise<void>
  openRecoveryDialog: () => void
  confirmRecoveryAudit: () => Promise<void>
  requestPlanReviews: () => void
  addressPlanReviews: () => void
}

export function useSprintEngineBoardTerminalActions(
  input: SprintEngineBoardTerminalActionsInput,
): SprintEngineBoardTerminalActions {
  const {
    workspaceId,
    workspace,
    agents,
    sprintEngineState,
    rosterById,
    architectAgentId,
    specialistReviewAgents,
    savedFolderPath,
    folderPath,
    folderStatusMessage,
    folderCheckedPath,
    lastSelectedCli,
    recoveryDialog,
    updateAgent,
    recheckFolder,
    setSelectedAgentId,
    setCliPickerOpen,
    setRecoveryDialog,
    getAgentName,
    getCustomAgentName,
    getLiveAgentTerminalSession,
  } = input

  const startAgentTerminal: SprintEngineBoardTerminalActions['startAgentTerminal'] = (
    agentId,
    label,
    cli,
    options,
  ) => {
    const current = agents[agentId]
    const selectedCli = cli ?? current?.cli
    if (!selectedCli) {
      void publishDiagnostic({
        level: 'error',
        source: 'terminal',
        title: `${label} was not started`,
        message: 'Sprint agent is missing its CLI selection.',
        details: [
          `Workspace ID: ${workspaceId}`,
          `Agent ID: ${agentId}`,
        ].join('\n'),
        workspaceId,
        workspaceName: workspace?.name,
        agentId,
      })
      return false
    }
    // Resume path: re-open a recorded session (e.g. "talk to the architect"
    // after the run finished). Reuse the recorded id and flag resume intent so
    // TerminalView relaunches with `--resume` rather than starting a new
    // conversation. No fresh startup prompt is sent.
    if (options?.resumeSessionId) {
      updateAgent(workspaceId, agentId, {
        name: label,
        ...(options?.execution ? { execution: options.execution } : {}),
        cli: selectedCli,
        ...(options?.cliModel !== undefined ? { cliModel: options.cliModel ?? undefined } : {}),
        cliSessionId: options.resumeSessionId,
        harnessSessionId: options.resumeHarnessSessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeRequested: true,
        cliResumeAvailable: true,
        cliOnboardingPromptSent: true,
        cliStartupPrompt: undefined,
        cliLastExitCode: undefined,
        cliLastExitedAt: undefined,
        kind: 'sprintengine',
      })
      focusOrAddAgentTab(workspaceId, agentId, label)
      return true
    }

    const role = sprintEngineState?.sprintEngineAgents[agentId]?.role
    const roleLabel = role ? getSprintEngineRoleLabel(role) : undefined
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
      cliResumeAvailable: shouldStartFresh ? false : current?.cliResumeAvailable ?? false,
      // Fresh/restart spawns never carry a resume intent; only the explicit
      // resume path above sets it.
      cliResumeRequested: false,
      cliLastExitCode: undefined,
      cliLastExitedAt: undefined,
      cli: selectedCli,
      ...(options?.cliModel !== undefined ? { cliModel: options.cliModel ?? undefined } : {}),
      cliStartupPrompt: startupPrompt,
      kind: 'sprintengine',
    })
    if (options?.reveal === 'background') {
      // Materialise the tab docked-but-unfocused. Only when it's missing — an
      // already-open tab must not be re-selected, matching the board reveal
      // contract for supervised launches.
      if (!hasAgentTab(workspaceId, agentId)) {
        addAgentTabTiled(workspaceId, agentId, label, undefined, false)
      }
    } else {
      focusOrAddAgentTab(workspaceId, agentId, label)
    }
    return true
  }

  const ensureWorkspaceFolderReadyForLaunch: SprintEngineBoardTerminalActions['ensureWorkspaceFolderReadyForLaunch']
    = async (agentId, label) => {
      if (!savedFolderPath) return true

      const result: WorkspaceFolderCheckResult = folderPath
        ? ({ ok: true, status: 'ready', path: savedFolderPath, checkedPath: folderPath, message: `Workspace folder is ready: ${folderPath}` } as unknown as WorkspaceFolderCheckResult)
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

  const startAgentTerminalWhenReady: SprintEngineBoardTerminalActions['startAgentTerminalWhenReady']
    = async (agentId, label, cli, options) => {
      if (!(await ensureWorkspaceFolderReadyForLaunch(agentId, label))) return false
      return startAgentTerminal(agentId, label, cli, options)
    }

  const openAgentTerminal: SprintEngineBoardTerminalActions['openAgentTerminal'] = (agentId) => {
    const fallbackLabel = rosterById[agentId]?.label ?? agentId
    const label = getAgentName(agentId, fallbackLabel)
    const liveSession = getLiveAgentTerminalSession(agentId)
    setSelectedAgentId(agentId)
    if (liveSession) {
      const effectiveCli = liveSession.cli ?? agents[agentId]?.cli
      updateAgent(workspaceId, agentId, {
        name: label,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliOnboardingPromptSent: true,
        cliSessionId: liveSession.sessionId,
        ...(effectiveCli ? { cli: effectiveCli } : {}),
        kind: 'sprintengine',
      })
      focusOrAddAgentTab(workspaceId, agentId, label, { sessionId: liveSession.sessionId })
      return
    }
    updateAgent(workspaceId, agentId, {
      name: label,
      cliStartRequested: false,
      cliHasLaunched: false,
      cliSessionId: undefined,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
      kind: 'sprintengine',
    })
    focusOrAddAgentTab(workspaceId, agentId, label)
  }

  const stopAgentTerminal: SprintEngineBoardTerminalActions['stopAgentTerminal'] = async (agentId) => {
    const fallbackLabel = rosterById[agentId]?.label ?? agentId
    const label = getAgentName(agentId, fallbackLabel)
    const liveSession = getLiveAgentTerminalSession(agentId)
    if (!liveSession) {
      void publishDiagnostic({
        level: 'warning',
        source: 'terminal',
        title: `${label} has no live terminal`,
        message: 'The agent terminal was already stopped.',
        details: [
          `Workspace ID: ${workspaceId}`,
          `Agent ID: ${agentId}`,
        ].join('\n'),
        workspaceId,
        workspaceName: workspace?.name,
        agentId,
      })
      return false
    }
    try {
      await window.api.terminalKill(liveSession.sessionId)
    } catch (error) {
      void publishDiagnostic({
        level: 'error',
        source: 'terminal',
        title: `${label} could not be stopped`,
        message: error instanceof Error ? error.message : 'Killing the agent terminal failed.',
        details: [
          `Workspace ID: ${workspaceId}`,
          `Agent ID: ${agentId}`,
          `Session ID: ${liveSession.sessionId}`,
        ].join('\n'),
        workspaceId,
        workspaceName: workspace?.name,
        agentId,
      })
      return false
    }
    // Local launch flags only — canonical roster membership stays intact and
    // the main-process teardown handles sprintengine.agent.leave.
    updateAgent(workspaceId, agentId, {
      cliStartRequested: false,
      cliHasLaunched: false,
      cliSessionId: undefined,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
      kind: 'sprintengine',
    })
    return true
  }

  const restartAgentTerminal: SprintEngineBoardTerminalActions['restartAgentTerminal'] = async (agentId) => {
    const fallbackLabel = rosterById[agentId]?.label ?? agentId
    const label = getAgentName(agentId, fallbackLabel)
    return startAgentTerminalWhenReady(agentId, label, agents[agentId]?.cli, {
      freshSession: true,
      agentName: getCustomAgentName(agentId, fallbackLabel),
    })
  }

  const spawnAgent: SprintEngineBoardTerminalActions['spawnAgent'] = async (agentId) => {
    setSelectedAgentId(agentId)

    // Already running — focus the existing terminal rather than re-spawn.
    if (getLiveAgentTerminalSession(agentId)) {
      openAgentTerminal(agentId)
      return
    }

    const agentState = agents[agentId]
    const fallbackLabel = rosterById[agentId]?.label ?? agentId
    const label = getAgentName(agentId, fallbackLabel)

    // Prefer resuming the role's recorded session (teardown removed the panel
    // but kept the session), so re-opening a departed agent continues its
    // conversation instead of starting fresh. Resume covers both whole-run
    // completion teardown and mid-run departed-worker teardown (B4); a stale
    // recorded entry from a prior run on the same workspace still can't hijack a
    // fresh spawn (see `shouldResumeRecordedRosterSession`). Only when there is
    // no live terminal and the recorded CLI supports conversation resume.
    const recorded = workspace?.sprintEngineRosterSessions?.[agentId]
    const shouldResume = shouldResumeRecordedRosterSession({
      sprintEngineState,
      autoRuntimeState: workspace?.sprintEngineAutoState?.runtimeState,
      agentId,
    })
    if (shouldResume && recorded?.cliSessionId && agentCliSupportsConversationResume(recorded.cli)) {
      await startAgentTerminalWhenReady(agentId, label, recorded.cli, {
        agentName: getCustomAgentName(agentId, fallbackLabel),
        resumeSessionId: recorded.cliSessionId,
        resumeHarnessSessionId: recorded.harnessSessionId,
        cliModel: recorded.cliModel ?? null,
      })
      return
    }

    const role = rosterById[agentId]?.role
    const roleDefaultCli = role
      ? workspace?.sprintEngineRoleCliDefaults?.[role] ?? lastSelectedCli
      : lastSelectedCli
    const cli = agentState?.cli ?? roleDefaultCli

    await startAgentTerminalWhenReady(agentId, label, cli, {
      agentName: getCustomAgentName(agentId, fallbackLabel),
      freshSession: true,
      cliModel: agentState?.cliModel ?? null,
    })
  }

  const openRecoveryDialog: SprintEngineBoardTerminalActions['openRecoveryDialog'] = () => {
    setCliPickerOpen(false)
    setRecoveryDialog({ cli: 'codex', model: undefined })
  }

  const confirmRecoveryAudit: SprintEngineBoardTerminalActions['confirmRecoveryAudit'] = async () => {
    if (!recoveryDialog || !architectAgentId || !folderPath) return
    const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
    const label = getAgentName(architectAgentId, fallbackLabel)

    const started = await startAgentTerminalWhenReady(architectAgentId, label, recoveryDialog.cli, {
      freshSession: true,
      agentName: getCustomAgentName(architectAgentId, fallbackLabel),
      startupPrompt: buildSprintEngineRecoveryAuditPrompt(),
      cliModel: recoveryDialog.model ?? null,
    })
    if (!started) return
    setSelectedAgentId(architectAgentId)
    setCliPickerOpen(false)
    setRecoveryDialog(null)
  }

  const requestPlanReviews: SprintEngineBoardTerminalActions['requestPlanReviews'] = () => {
    if (!folderPath || specialistReviewAgents.length === 0) return

    specialistReviewAgents.forEach((agent) => {
      const label = getAgentName(agent.id, agent.label)
      void startAgentTerminalWhenReady(agent.id, label, agents[agent.id]?.cli, {
        freshSession: true,
        agentName: getCustomAgentName(agent.id, agent.label),
        startupPrompt: buildSprintEnginePlanReviewStartupPrompt(agent.role, agent.id),
      })
    })

    setSelectedAgentId(specialistReviewAgents.at(-1)?.id ?? null)
  }

  const addressPlanReviews: SprintEngineBoardTerminalActions['addressPlanReviews'] = () => {
    if (!folderPath || !architectAgentId) return
    const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
    const label = getAgentName(architectAgentId, fallbackLabel)

    void startAgentTerminalWhenReady(architectAgentId, label, agents[architectAgentId]?.cli, {
      freshSession: true,
      agentName: getCustomAgentName(architectAgentId, fallbackLabel),
      startupPrompt: buildSprintEngineAddressPlanReviewsPrompt(),
    })
    setSelectedAgentId(architectAgentId)
  }

  return {
    startAgentTerminal,
    startAgentTerminalWhenReady,
    ensureWorkspaceFolderReadyForLaunch,
    openAgentTerminal,
    stopAgentTerminal,
    restartAgentTerminal,
    spawnAgent,
    openRecoveryDialog,
    confirmRecoveryAudit,
    requestPlanReviews,
    addressPlanReviews,
  }
}
