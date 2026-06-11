import type { Dispatch, SetStateAction } from 'react'
import type {
  AgentCli,
  AgentExecution,
  AgentState,
  SprintEngineState,
  Workspace,
  WorkspaceId,
} from '../../../types/workspace'
import { focusOrAddAgentTab } from '../../../utils/modelRegistry'
import { getSprintEngineRoleLabel, type SprintEngineAgentRosterItem } from '../../../utils/sprintengine'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../../utils/agentPrompt'
import { publishDiagnostic } from '../../../utils/diagnostics'
import {
  buildSprintEngineAddressPlanReviewsPrompt,
  buildSprintEnginePlanReviewStartupPrompt,
  buildSprintEngineRecoveryAuditPrompt,
} from '../../../utils/sprintenginePlanReviewPrompts'

type SpawnDialogState = {
  agentId: string
  cli: AgentCli
  // Model id passed at CLI launch; undefined means the CLI's own default.
  model?: string
  name: string
}

type RecoveryDialogState = {
  cli: AgentCli
  model?: string
}

type StartAgentTerminalOptions = {
  startupPrompt?: string
  freshSession?: boolean
  agentName?: string
  execution?: AgentExecution
  // string sets the launch model, null clears it back to the CLI default,
  // undefined preserves whatever the agent already has.
  cliModel?: string | null
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
  cliModelDefaults: Partial<Record<AgentCli, string>>
  spawnDialog: SpawnDialogState | null
  recoveryDialog: RecoveryDialogState | null
  spawnDialogHasLiveTerminal: boolean
  updateAgent: (workspaceId: WorkspaceId, agentId: string, update: Partial<AgentState>) => void
  recheckFolder: () => void
  setSelectedAgentId: Dispatch<SetStateAction<string | null>>
  setCliPickerOpen: Dispatch<SetStateAction<boolean>>
  setSpawnDialog: Dispatch<SetStateAction<SpawnDialogState | null>>
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
  openSpawnDialog: (agentId: string) => void
  confirmSpawnDialog: () => Promise<void>
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
    cliModelDefaults,
    spawnDialog,
    recoveryDialog,
    spawnDialogHasLiveTerminal,
    updateAgent,
    recheckFolder,
    setSelectedAgentId,
    setCliPickerOpen,
    setSpawnDialog,
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
        message: 'Sprint Engine agent is missing its CLI selection.',
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
      cliLastExitCode: undefined,
      cliLastExitedAt: undefined,
      cli: selectedCli,
      ...(options?.cliModel !== undefined ? { cliModel: options.cliModel ?? undefined } : {}),
      cliStartupPrompt: startupPrompt,
      kind: 'sprintengine',
    })
    focusOrAddAgentTab(workspaceId, agentId, label)
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

  const openSpawnDialog: SprintEngineBoardTerminalActions['openSpawnDialog'] = (agentId) => {
    const agentState = agents[agentId]
    const defaultName = rosterById[agentId]?.label ?? agentId
    const role = rosterById[agentId]?.role
    const defaultCli = role ? workspace?.sprintEngineRoleCliDefaults?.[role] ?? lastSelectedCli : lastSelectedCli
    const savedName = agentState?.name && agentState.name !== defaultName ? agentState.name : ''
    setSelectedAgentId(agentId)
    setCliPickerOpen(false)
    const dialogCli = agentState?.cli ?? defaultCli
    setSpawnDialog({
      agentId,
      cli: dialogCli,
      model: agentState?.cliModel ?? cliModelDefaults[dialogCli],
      name: savedName,
    })
  }

  const confirmSpawnDialog: SprintEngineBoardTerminalActions['confirmSpawnDialog'] = async () => {
    if (!spawnDialog) return
    const defaultName = rosterById[spawnDialog.agentId]?.label ?? spawnDialog.agentId
    const agentName = normalizeAgentIdentifier(spawnDialog.name)
    const label = agentName || defaultName
    const started = await startAgentTerminalWhenReady(spawnDialog.agentId, label, spawnDialog.cli, {
      agentName,
      freshSession: !spawnDialogHasLiveTerminal,
      cliModel: spawnDialog.model ?? null,
    })
    if (!started) return
    setCliPickerOpen(false)
    setSpawnDialog(null)
  }

  const openRecoveryDialog: SprintEngineBoardTerminalActions['openRecoveryDialog'] = () => {
    setCliPickerOpen(false)
    setRecoveryDialog({ cli: 'codex', model: cliModelDefaults.codex })
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
    openSpawnDialog,
    confirmSpawnDialog,
    openRecoveryDialog,
    confirmRecoveryAudit,
    requestPlanReviews,
    addressPlanReviews,
  }
}
