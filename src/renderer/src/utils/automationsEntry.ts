import { AUTOMATIONS_HOST_WORKSPACE_MODE, type Workspace } from '../types/workspace'

// The Automations front door (sidebar utility rail) is a destination/launcher,
// not a creation action: picking a project reveals that project's existing
// Automations host workspace, or creates one only when none exists. Both the
// resolver and the project-folder list are pure so the entry-point behavior is
// unit-testable without the shell.

function normalizeFolderPath(value: string | null | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function folderDisplayName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

export type AutomationsHostCandidate = Pick<Workspace, 'id' | 'mode' | 'folderPath'>

export type AutomationsEntryResolution =
  | { kind: 'reveal'; workspaceId: string }
  | { kind: 'create'; folderPath: string }

// Reveal-or-create for a project's Automations host. Honors the one-host-per-
// folder invariant the run executor already enforces (`findHostWorkspaceByFolder`)
// — the first existing host for the folder wins, so the entry point never spawns
// a duplicate host beside an existing one.
export function resolveAutomationsHostForFolder(
  workspaces: ReadonlyArray<AutomationsHostCandidate>,
  folderPath: string,
): AutomationsEntryResolution {
  const target = normalizeFolderPath(folderPath)
  const existing = workspaces.find(
    (workspace) =>
      workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE &&
      normalizeFolderPath(workspace.folderPath) === target,
  )
  return existing ? { kind: 'reveal', workspaceId: existing.id } : { kind: 'create', folderPath }
}

export type AutomationsProjectFolder = {
  folderPath: string
  displayName: string
  // Whether this project already has an Automations host (the picker labels it
  // "Open" vs "Create" so the user knows which action a row takes).
  hasHost: boolean
}

// Distinct project folders for the front-door picker, in first-seen order. A
// workspace with no folder is skipped (Automations is strictly per-project).
export function listAutomationsProjectFolders(
  workspaces: ReadonlyArray<AutomationsHostCandidate>,
): AutomationsProjectFolder[] {
  const seen = new Map<string, AutomationsProjectFolder>()
  for (const workspace of workspaces) {
    const folderPath = workspace.folderPath
    if (!folderPath) continue
    const key = normalizeFolderPath(folderPath)
    const isHost = workspace.mode === AUTOMATIONS_HOST_WORKSPACE_MODE
    const existing = seen.get(key)
    if (existing) {
      if (isHost) existing.hasHost = true
      continue
    }
    seen.set(key, { folderPath, displayName: folderDisplayName(folderPath), hasHost: isHost })
  }
  return [...seen.values()]
}
