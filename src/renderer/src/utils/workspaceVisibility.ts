import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  isModeHiddenFromRail,
  type WorkspaceMode,
} from '../../../shared/workspace-mode'
import { getRendererHost, selectModuleEnabled } from '../modules'
import type { ModuleEnablementOverrides } from '../../../shared/modules/manifest'

// Workspace-mode predicates so the executor, sidebar rail, and tests can all
// import them. Callers pass any object carrying a `mode`; only the mode is
// read. Rail-hidden-ness for a module-registered type is a registered-type
// query (`hiddenFromRail`), so this file reads the renderer host.
type WorkspaceModeInput = { mode: WorkspaceMode }

// True for the background Automations host workspace.
export function isAutomationsHostWorkspace(workspace: WorkspaceModeInput): boolean {
  return workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE
}

function moduleEnabledFromOverrides(
  moduleOverrides?: ModuleEnablementOverrides,
): ((moduleId: string) => boolean) | undefined {
  return moduleOverrides ? (moduleId) => selectModuleEnabled(moduleOverrides, moduleId) : undefined
}

// True for a workspace whose registered type set `hiddenFromRail` and whose
// owning module is enabled. When the module is disabled (or the type is not
// registered) this is false, so a persisted workspace of that type can appear
// on the rail as an absence surface rather than vanishing with its door.
export function isRailHiddenModuleWorkspace(
  workspace: WorkspaceModeInput,
  moduleOverrides?: ModuleEnablementOverrides,
): boolean {
  const types = getRendererHost().getWorkspaceTypes(moduleEnabledFromOverrides(moduleOverrides))
  return types.some((type) => type.id === workspace.mode && type.hiddenFromRail === true)
}

// True when the workspace should not appear in the normal workspace rail.
// Hidden-ness is derived from the bundled automations-host predicate plus any
// registered type that set `hiddenFromRail` — never a persisted field.
//
// - The Automations host (epic 1704) is a background runtime container for
//   agent-backed automation runs. It stays a bundled mode, so the shared
//   `isModeHiddenFromRail` covers it even when the automations module is off.
// - A module-registered type that declares `hiddenFromRail` is a background
//   residency for that module's agent terminals; its own door is how the work
//   is found. The flag lives on the registered type, so disabling the module
//   un-hides a persisted workspace of that type and the absence surface can
//   name the module.
//
// Hidden means hidden from DISCOVERY, not disabled: both stay in the store, in
// window assignments, and mounted/activatable, and an active hidden workspace
// renders its own layout, header, and tabs exactly like any other. What they
// never do is render as a Projects-list row, a keyboard switch target, or a
// command-palette result.
export function isHiddenFromRail(workspace: WorkspaceModeInput, moduleOverrides?: ModuleEnablementOverrides): boolean {
  if (isModeHiddenFromRail(workspace.mode)) return true
  return isRailHiddenModuleWorkspace(workspace, moduleOverrides)
}
