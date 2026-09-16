// One predicate for "this workspace is a Sprint Engine run surface", shared by
// the run-glyph provider registration and workspace auto-archive so the sidebar
// glyph and the archive sweep can never disagree about membership. Structural
// input (a subset of Workspace) keeps it usable from both the provider's
// narrowed projection and plain test fixtures.
//
// The nav-row model that used to live beside it (buildSprintEngineNavRows and
// the aside's view/sort lenses) retired with the Sprint Engines aside itself
// (MC-1766). The Sprints door surface derives its rail from the run index
// instead — see globalSurface/sprints/railState.ts.
import { sprintEngineRunContext, sprintEngineRunState } from '../store/slices/workspaceModuleState'
import type { Workspace } from '../types/workspace'
import type { SprintEngineWorkspaceView } from '../../../shared/sprintengine/run-types'

export function isSprintEngineWorkspace(workspace: {
  mode: string
  moduleState?: Record<string, unknown>
}): boolean {
  const entry = workspace.moduleState?.sprintengine
  if (workspace.mode === 'sprintengine') return true
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
