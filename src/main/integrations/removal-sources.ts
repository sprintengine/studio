// Where the removal looks, beyond the ledger: the workspaces the app knows,
// and the homes of the WSL distributions it has written into. Read from the
// profile's files, so the command line (which starts none of the app's
// services) and Settings see the same thing.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseWorkspaceRegistryFile } from '../../shared/workspace-registry'
import type { ScanHome } from './integration-scan'
import type { IntegrationLedgerEntry } from './ledger'

const WORKSPACE_REGISTRY_FILE = 'workspace-registry.json'

/** The folders of every workspace in the profile's registry; none when it cannot be read. */
export function readRegistryRoots(userDataDir: string): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(userDataDir, WORKSPACE_REGISTRY_FILE), 'utf8'))
    const parsed = parseWorkspaceRegistryFile(raw)
    if (!parsed) return []
    return parsed.file.workspaces.flatMap((workspace) => (workspace.folderPath ? [workspace.folderPath] : []))
  } catch {
    return []
  }
}

/**
 * Each distribution's home, as this process opens it, from the app-data entry
 * its preparation recorded (`<home>/.local/share/sprintengine-studio`).
 */
export function wslHomesFromLedger(entries: readonly IntegrationLedgerEntry[]): ScanHome[] {
  const homes = new Map<string, ScanHome>()
  for (const entry of entries) {
    if (entry.kind !== 'wsl-data') continue
    const native = dirname(dirname(dirname(entry.path)))
    homes.set(entry.hostId, { native, hostId: entry.hostId })
  }
  return [...homes.values()]
}
