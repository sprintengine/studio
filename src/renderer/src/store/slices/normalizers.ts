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

export function normalizeWorkspaceForPartialize(workspace: Workspace): Workspace {
  const sprintEngineAutoState = normalizeSprintEngineAutoState(workspace.sprintEngineAutoState)
  return {
    ...workspace,
    mode: normalizeWorkspaceMode(workspace.mode, workspace.sprintEngineState, workspace.multiloopState),
    guidedBriefState: normalizeGuidedBriefState(workspace.guidedBriefState),
    memory: normalizeWorkspaceMemoryConfig(workspace.memory),
    sprintEngineAutoState: {
      ...sprintEngineAutoState,
      supervisorEnabled: false,
      enabled: false,
      autoApproveArtifacts: false,
      pendingSpawns: [],
    },
    multiloopAutoState: normalizeMultiloopAutoState(workspace.multiloopAutoState),
    agents: Object.fromEntries(
      Object.entries(workspace.agents).map(([id, a]) => {
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
    worktreeState: normalizeWorkspaceWorktreeState(workspace.worktreeState),
    editorState: {
      openFiles: (workspace.editorState?.openFiles ?? []).map(({ content: _content, ...f }) => ({
        ...f,
        isDirty: false,
      })),
      activeFilePath: workspace.editorState?.activeFilePath ?? null,
    },
  }
}
