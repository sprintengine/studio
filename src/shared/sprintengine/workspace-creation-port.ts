/**
 * The two workspace mutations sprint creation performs, as a port (MC-2160).
 *
 * Creation composes the run — context, engine init, roster, handoff prompt — and
 * then has to (1) register the workspace and (2) hand the coordinator seat its
 * startup prompt. Those two steps are the only process-specific ones: a window
 * runs them through the renderer store, main runs them through the workspace
 * registry and the sprint scheduler. Everything else is one shared code path.
 */
import type {
  SprintEngineAutoState,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceId,
  WorkspaceWindowId,
} from '../../renderer/src/types/workspace'

export type SprintEngineWorkspaceRegistration = {
  /** The initialized run state — its name is the workspace's name. */
  sprintEngineState: SprintEngineState
  sprintEngineContext: SprintEngineWorkspaceContext
  folderPath: string
  roleCliDefaults?: SprintEngineRoleCliDefaults | null
  roleModelOverrides?: SprintEngineRoleModelOverrides | null
  /** Per-agent CLI pinned in the roster editor, by agent id. */
  agentCliOverrides?: Record<string, string> | null
  /** Role keys whose seat carries a start-at-launch intent. */
  initialSpawnRoles?: SprintEngineRoleId[] | null
  sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
  windowId?: WorkspaceWindowId | null
}

export type SprintEngineWorkspaceCreationPort = {
  /** Register the composed run as a workspace; returns its id. */
  addWorkspace(registration: SprintEngineWorkspaceRegistration): WorkspaceId | Promise<WorkspaceId>
  /**
   * Queue the coordinator seat's startup prompt. Called only for a run that
   * plans (a direct-intake run has no planning session to start).
   */
  setStartupPrompt(input: {
    workspaceId: WorkspaceId
    agentId: string
    startupPrompt: string
  }): void | Promise<void>
}
