/**
 * The renderer's wiring of the shared sprint-creation workspace port (MC-2160).
 *
 * The creation path itself moved to `src/shared/sprintengine/workspace-creation.ts`
 * so main can run it with no window open. Its only process-specific steps —
 * register the composed run, hand the coordinator seat its startup prompt — are
 * the port implemented here against the renderer store, exactly the two calls
 * that used to be inline.
 */
import { createSprintEngineTemplate } from '../modules/sprint-engine-workspace-types'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { SprintEngineWorkspaceCreationPort } from '../../../shared/sprintengine/workspace-creation-port'

export const rendererSprintEngineWorkspaceCreationPort: SprintEngineWorkspaceCreationPort = {
  addWorkspace: (registration) =>
    useWorkspaceStore.getState().addWorkspace(
      createSprintEngineTemplate({
        name: registration.sprintEngineState.name,
        goal: registration.sprintEngineState.goal,
        roleCounts: registration.sprintEngineState.roleCounts,
      }),
      {
        name: registration.sprintEngineContext.teamName,
        folderPath: registration.folderPath,
        sprintEngineState: registration.sprintEngineState,
        sprintEngineContext: registration.sprintEngineContext,
        sprintEngineRoleCliDefaults: registration.roleCliDefaults,
        sprintEngineRoleModelOverrides: registration.roleModelOverrides,
        sprintEngineAgentCliOverrides: registration.agentCliOverrides,
        sprintEngineInitialSpawnRoles: registration.initialSpawnRoles,
        sprintEngineAutoState: registration.sprintEngineAutoState,
        windowId: registration.windowId,
      },
    ),
  setStartupPrompt: ({ workspaceId, agentId, startupPrompt }) => {
    useWorkspaceStore.getState().updateAgent(workspaceId, agentId, {
      cliStartupPrompt: startupPrompt,
      cliOnboardingPromptSent: false,
    })
  },
}
