// One predicate for "this workspace is a Sprint Engine run surface", shared by
// the run-glyph provider registration and workspace auto-archive so the sidebar
// glyph and the archive sweep can never disagree about membership. Structural
// input (a subset of Workspace) keeps it usable from both the provider's
// narrowed projection and plain test fixtures.
//
// Matched on the registered type id or a sprintengine bag entry — never a
// bundled-mode enum. The nav-row model that used to live beside it retired with
// the Sprint Engines aside (MC-1766). The Sprints door surface derives its rail
// from the run index instead — see globalSurface/sprints/railState.ts.
import {
  SPRINT_ENGINE_WORKSPACE_MODULE_ID,
  SPRINT_ENGINE_WORKSPACE_TYPE_ID,
} from '../../../shared/sprintengine/workspace-record'
import { sprintEngineRunContext, sprintEngineRunState } from '../store/slices/workspaceModuleState'
import type { Workspace } from '../types/workspace'
import type { SprintEngineWorkspaceView } from '../../../shared/sprintengine/run-types'

export function isSprintEngineWorkspace(workspace: {
  mode: string
  moduleState?: Record<string, unknown>
}): boolean {
  if (workspace.mode === SPRINT_ENGINE_WORKSPACE_TYPE_ID) return true
  const entry = workspace.moduleState?.[SPRINT_ENGINE_WORKSPACE_MODULE_ID]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  return 'context' in entry || 'state' in entry || 'roleCounts' in entry
}

/** Fill the auto-run / planner view from the module bag. */
export function toSprintEngineWorkspaceView(workspace: Workspace): SprintEngineWorkspaceView {
  return {
    id: workspace.id,
    name: workspace.name,
    folderPath: workspace.folderPath,
    folderMissing: workspace.folderMissing,
    agents: workspace.agents,
    sprintEngineState: sprintEngineRunState(workspace),
    sprintEngineAutoState: workspace.sprintEngineAutoState,
    sprintEngineContext: sprintEngineRunContext(workspace),
    memory: workspace.memory,
  }
}
