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
// Hidden-ness is derived from the mode, never a persisted field. The Automations
// workspace is now a visible, user-created workspace type that hosts its run
// terminals in plain sight, so nothing is currently rail-hidden. The predicate is
// retained as the single chokepoint for any future hidden mode.
export function isHiddenFromRail(_workspace: WorkspaceModeInput): boolean {
  return false
}

// True when the user archived the workspace (Sprints aside row action).
// Deliberately separate from isHiddenFromRail: rail lists filter archived rows
// out, but the command palette / search keeps them findable and window
// assignment never consults this.
export function isArchivedWorkspace(workspace: { archivedAt?: number | null }): boolean {
  return typeof workspace.archivedAt === 'number'
}
