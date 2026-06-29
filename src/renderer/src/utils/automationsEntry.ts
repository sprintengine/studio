import { AUTOMATIONS_HOST_WORKSPACE_MODE, type Workspace } from '../types/workspace'

// The Automations front door (sidebar utility rail) is a pure navigation
// affordance: it lists the project Automations workspaces that already exist and
// lets the user jump to one. Creating an Automations workspace stays the job of
// the New-workspace mode card — the rail never creates. Kept pure so the
// entry-point list is unit-testable without the shell.

function folderDisplayName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

export type AutomationsHostCandidate = Pick<Workspace, 'id' | 'mode' | 'name' | 'folderPath'>

export type AutomationsHostEntry = {
  id: string
  name: string
  folderPath: string | null
  // Folder basename — the label that identifies which project the Automations
  // workspace belongs to (default-named hosts all read "Automations").
  displayName: string
}

// The existing Automations host workspaces, in the given order, for the
// front-door picker. A host with no folder still lists (it is still openable),
// falling back to its workspace name for the label.
export function listAutomationsHostWorkspaces(
  workspaces: ReadonlyArray<AutomationsHostCandidate>,
): AutomationsHostEntry[] {
  return workspaces
    .filter((workspace) => workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE)
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      folderPath: workspace.folderPath,
      displayName: workspace.folderPath ? folderDisplayName(workspace.folderPath) : workspace.name,
    }))
}
