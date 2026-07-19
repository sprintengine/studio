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
// Hidden-ness is derived from the mode, never a persisted field. Automations are
// now an instance-level surface (the sidebar Automations door, epic 1704), so
// their host workspaces are kept only as background runtime containers for
// agent-backed runs — they stay in the store, in window assignments, and
// mounted/revealable, but never render as a Projects-list row, a switch target,
// or a command-palette result. This is the single chokepoint every rail-facing
// list consults (sidebar, WorkspaceManager, command palette).
export function isHiddenFromRail(workspace: WorkspaceModeInput): boolean {
  return isAutomationsHostWorkspace(workspace)
}

// True when the user archived the workspace (Sprints aside row action).
// Deliberately separate from isHiddenFromRail: rail lists filter archived rows
// out, but the command palette / search keeps them findable and window
// assignment never consults this.
export function isArchivedWorkspace(workspace: { archivedAt?: number | null }): boolean {
  return typeof workspace.archivedAt === 'number'
}
