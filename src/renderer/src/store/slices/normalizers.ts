import type { Workspace } from '../../types/workspace'
import { normalizeAgentState } from './agentsSlice'
import { normalizeGuidedBriefState } from './guidedBriefSlice'
import { normalizeWorkspaceMemoryConfig } from './memorySlice'
import {
  normalizeMultiloopAutoState,
  normalizeSprintEngineAutoState,
} from './runStateSlice'
import { normalizeWorkspaceMode } from './workspacesSlice'
import { normalizeWorkspaceWorktreeState } from './worktreesSlice'

export function mapMigrationWorkspaces<T extends { workspaces: Workspace[] }>(
  state: T,
  migrate: (workspace: Workspace) => Workspace,
): void {
  state.workspaces = state.workspaces.map(migrate)
}

export function clearSprintEngineAgentLaunchState(workspace: Workspace): Workspace {
  if (workspace.mode !== 'sprintengine' && !workspace.sprintEngineState) return workspace

  const sprintEngineAgentIds = new Set(Object.keys(workspace.sprintEngineState?.sprintEngineAgents ?? {}))
  const hasSprintEngineAgents = Object.entries(workspace.agents).some(
    ([id, agent]) => agent.kind === 'sprintengine' || sprintEngineAgentIds.has(id)
  )
  if (!hasSprintEngineAgents) return workspace

  return {
    ...workspace,
    agents: Object.fromEntries(
      Object.entries(workspace.agents).map(([id, agent]) => {
        if (agent.kind !== 'sprintengine' && !sprintEngineAgentIds.has(id)) return [id, agent]
        return [
          id,
          normalizeAgentState({
            ...agent,
            kind: 'sprintengine',
            status: 'idle',
            streamBuffer: '',
            cliSessionId: undefined,
            cliStartRequested: false,
            cliRestartNonce: 0,
            cliHasLaunched: false,
            cliOnboardingPromptSent: false,
            cliResumeAvailable: false,
            cliStartupPrompt: undefined,
          }),
        ]
      }),
    ),
  }
}

export function preserveNewerSprintEngineAutomationState(
  incomingWorkspace: Workspace,
  currentWorkspace: Workspace | undefined,
): Workspace {
  if (!currentWorkspace?.sprintEngineAutoState) return incomingWorkspace

  const incomingAutoState = normalizeSprintEngineAutoState(incomingWorkspace.sprintEngineAutoState)
  const currentAutoState = normalizeSprintEngineAutoState(currentWorkspace.sprintEngineAutoState)
  const incomingChangedAt = incomingAutoState.changedAt
  const currentChangedAt = currentAutoState.changedAt
  const currentIsNewer =
    typeof currentChangedAt === 'number'
    && (
      typeof incomingChangedAt !== 'number'
      || currentChangedAt > incomingChangedAt
    )

  if (!currentIsNewer) return incomingWorkspace
  return {
    ...incomingWorkspace,
    sprintEngineAutoState: currentAutoState,
  }
}

export function normalizeWorkspaceForPartialize(workspace: Workspace): Workspace {
  const sprintEngineAutoState = normalizeSprintEngineAutoState(workspace.sprintEngineAutoState)
  const launchSafeWorkspace = clearSprintEngineAgentLaunchState(workspace)
  return {
    ...launchSafeWorkspace,
    mode: normalizeWorkspaceMode(launchSafeWorkspace.mode, launchSafeWorkspace.sprintEngineState, launchSafeWorkspace.multiloopState),
    guidedBriefState: normalizeGuidedBriefState(launchSafeWorkspace.guidedBriefState),
    memory: normalizeWorkspaceMemoryConfig(launchSafeWorkspace.memory),
    sprintEngineAutoState: {
      ...sprintEngineAutoState,
      pendingSpawns: [],
    },
    multiloopAutoState: normalizeMultiloopAutoState(launchSafeWorkspace.multiloopAutoState),
    agents: Object.fromEntries(
      Object.entries(launchSafeWorkspace.agents).map(([id, a]) => {
        const shouldKeepStartupPrompt =
          !a.cliOnboardingPromptSent
          && (
            (a.kind === 'specialist' && Boolean(a.specialistId))
            || (a.kind === 'multiloop' && Boolean(a.multiloopRole))
            || (a.kind === 'watchtower' && Boolean(a.specialistId))
          )
        const cliStartupPrompt = shouldKeepStartupPrompt ? a.cliStartupPrompt : undefined

        // Keep durable resume identity in the registry. These fields are not
        // just process noise: Claude uses cliSessionId for `claude --resume`,
        // and Codex uses cliResumeAvailable/cliHasLaunched to restart with
        // `codex resume` after a full app restart. Strip only transient output
        // and one-shot restart state.
        return [
          id,
          normalizeAgentState({
            ...a,
            streamBuffer: '',
            status: 'idle' as const,
            cliStartupPrompt,
            cliRestartNonce: 0,
          }),
        ]
      }),
    ),
    worktreeState: normalizeWorkspaceWorktreeState(launchSafeWorkspace.worktreeState),
    editorState: {
      openFiles: (launchSafeWorkspace.editorState?.openFiles ?? []).map(({ content: _content, ...f }) => ({
        ...f,
        isDirty: false,
      })),
      activeFilePath: launchSafeWorkspace.editorState?.activeFilePath ?? null,
    },
  }
}
