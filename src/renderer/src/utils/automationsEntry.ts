import type { Workspace } from '../types/workspace'

// An automation belongs to a project scope, so creating one from the full-page
// Automations surface (global-surfaces epic 1704 / item 1707) needs the user to
// pick which project's store it lands in. This lists the known project folders —
// every distinct folder any workspace is rooted at — as the target-project
// chooser's options. Kept pure so the chooser list is unit-testable without the
// shell.
//
// (Replaces the old sidebar front-door picker, which listed Automations *host*
// workspaces to jump to; hosts are no longer sidebar citizens — the door owns
// the surface and this picks the create target.)

function folderDisplayName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

function normalizeFolderKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '')
}

export type AutomationProjectFolderCandidate = Pick<Workspace, 'folderPath'>

export type AutomationProjectFolder = {
  /** Absolute project root — the `workspaceRoot` a create/list call takes. */
  folderPath: string
  /** Folder basename — the label naming the project in the chooser. */
  displayName: string
}

// The distinct project folders across the given workspaces, in first-seen order,
// deduped by normalized path (case/separator-insensitive), skipping
// folder-less workspaces (chat/standard without a root). Every automation is
// stored under one of these roots, so this is the set of valid create targets.
export function listAutomationProjectFolders(
  workspaces: ReadonlyArray<AutomationProjectFolderCandidate>,
): AutomationProjectFolder[] {
  const seen = new Set<string>()
  const folders: AutomationProjectFolder[] = []
  for (const workspace of workspaces) {
    const folderPath = workspace.folderPath
    if (!folderPath) continue
    const key = normalizeFolderKey(folderPath).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    folders.push({ folderPath, displayName: folderDisplayName(folderPath) })
  }
  return folders
}
