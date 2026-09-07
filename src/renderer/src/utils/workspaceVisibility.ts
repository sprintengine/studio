import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  isModeHiddenFromRail,
  SPRINT_ENGINE_WORKSPACE_MODE,
  type WorkspaceMode,
} from '../../../shared/workspace-mode'

// Pure, dependency-free workspace-mode predicates so the executor, sidebar rail,
// and tests can all import them without dragging in store/module deps. Callers
// pass any object carrying a `mode`; only the mode is read.
type WorkspaceModeInput = { mode: WorkspaceMode }

// True for the background Automations host workspace.
export function isAutomationsHostWorkspace(workspace: WorkspaceModeInput): boolean {
  return workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE
}

// True for a workspace that exists to hold a Sprint Engine run's agent terminals.
// Matched on the mode alone — the run, not a persisted visibility field, is what
// makes it one.
export function isSprintRunWorkspace(workspace: WorkspaceModeInput): boolean {
  return workspace.mode === SPRINT_ENGINE_WORKSPACE_MODE
}

// True when the workspace should not appear in the normal workspace rail.
// Hidden-ness is derived from the mode, never a persisted field. Two kinds of
// workspace are hidden, for the same reason: an instance-level door surface took
// over finding and steering them, so listing them again under one project would
// claim they belong there.
//
// - The Automations host (epic 1704) is a background runtime container for
//   agent-backed automation runs.
// - Sprint-run workspaces (item 1767) are the execution residency for a run's
//   agent terminals. The Sprints door lists every run from disk — live and
//   historical, across every project — so the row is no longer how a run is
//   found; "Open agents" on the door canvas is.
//
// Hidden means hidden from DISCOVERY, not disabled: both stay in the store, in
// window assignments, and mounted/activatable, and an active hidden workspace
// renders its own layout, header, and tabs exactly like any other. What they
// never do is render as a Projects-list row, a keyboard switch target, or a
// command-palette result. This is the single chokepoint every rail-facing list
// consults (sidebar, WorkspaceManager, command palette), so reverting this one
// predicate restores the rows — nothing about a sprint workspace is migrated or
// deleted to hide it.
//
// The rule itself lives in `shared/workspace-mode.ts` (`isModeHiddenFromRail`)
// because main needs the same answer and cannot import the renderer — the
// review guide's workspace fallback consults it (item 1807). This stays the
// renderer's chokepoint and delegates, so there is one definition, not two.
export function isHiddenFromRail(workspace: WorkspaceModeInput): boolean {
  return isModeHiddenFromRail(workspace.mode)
}
