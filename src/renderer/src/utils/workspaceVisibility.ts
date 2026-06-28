import { AUTOMATIONS_HOST_WORKSPACE_MODE, type WorkspaceMode } from '../types/workspace'

// Pure, dependency-free workspace-mode predicates so the executor, sidebar rail,
// and tests can all import them without dragging in store/module deps. Callers
// pass any object carrying a `mode`; only the mode is read.
type WorkspaceModeInput = { mode: WorkspaceMode }

// True for the background Automations host workspace.
export function isAutomationsHostWorkspace(workspace: WorkspaceModeInput): boolean {
  return workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE
}

// True when the workspace should not appear in the normal workspace rail.
// Hidden-ness is derived from the mode, never a persisted field — currently only
// the Automations host is hidden.
export function isHiddenFromRail(workspace: WorkspaceModeInput): boolean {
  return isAutomationsHostWorkspace(workspace)
}
