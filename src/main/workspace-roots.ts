import { resolve } from 'path'

import { isMachinePath } from '../shared/machine-paths'
import type { WorkspaceSyncSnapshot } from '../shared/workspace-sync'

/**
 * The project roots main knows about with NO window open.
 *
 * The snapshot is the main-owned workspace registry
 * (`workspace-registry-service.ts`), loaded from userData at construction, so
 * this answers at app ready — before any renderer mounts, and with every
 * workspace's real folder rather than the subset a routing snapshot used to
 * carry. It is the roots source for every main-owned disk scan that must not
 * wait for a window: the phone's snapshot over the tailnet, for one.
 *
 * Bounded by construction: only workspaces this studio has open contribute a
 * root, so a scan over them is never a walk of the user's home directory.
 */
export function listKnownWorkspaceRoots(snapshot: WorkspaceSyncSnapshot): string[] {
  return uniqueResolvedRoots(snapshot.state.workspaces.map((workspace) => workspace.folderPath))
}

/**
 * Resolve, drop the empty ones, and dedupe, so two spellings of one folder
 * never become two scans. A folder on an SSH machine (`ssh://…`) is not one
 * of this computer's and is dropped too: resolved here, it would name a
 * folder under this process's working directory.
 */
export function uniqueResolvedRoots(roots: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim() || isMachinePath(root)) continue
    const resolved = resolve(root)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    unique.push(resolved)
  }
  return unique
}
