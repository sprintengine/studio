import { resolve } from 'path'
import type { WorkspaceSyncSnapshot } from '../shared/workspace-sync'

/**
 * The project roots main knows about with NO window open.
 *
 * The workspace-sync snapshot is restored from the persisted routing snapshot at
 * construction (`workspace-sync-routing-snapshot.ts` carries `workspaceFolderPaths`
 * across a restart), so this answers at app ready — before any renderer mounts and
 * pushes its open-workspace roots. It is the roots source for every main-owned
 * disk scan that must not wait for a window: boot-time sprint run discovery
 * (`sprintengine-boot-discovery.ts`) and the mobile relay's run snapshot.
 *
 * Bounded by construction: only workspaces this Multicode has open contribute a
 * root, so a scan over them is never a walk of the user's home directory.
 */
export function listKnownWorkspaceRoots(snapshot: WorkspaceSyncSnapshot): string[] {
  return uniqueResolvedRoots(snapshot.state.workspaces.map((workspace) => workspace.folderPath))
}

/**
 * Resolve, drop the empty ones, and dedupe — the same normalization the mobile
 * relay's IPC applies to renderer-pushed roots, so a root pushed by a window and
 * the same root read from the snapshot collapse to one scan.
 */
export function uniqueResolvedRoots(roots: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue
    const resolved = resolve(root)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    unique.push(resolved)
  }
  return unique
}
