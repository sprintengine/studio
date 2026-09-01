import { resolve } from 'path';
/**
 * The project roots main knows about with NO window open.
 *
 * The snapshot is the main-owned workspace registry
 * (`workspace-registry-service.ts`), loaded from userData at construction, so
 * this answers at app ready — before any renderer mounts, and with every
 * workspace's real folder rather than the subset a routing snapshot used to
 * carry. It is the roots source for every main-owned disk scan that must not
 * wait for a window: boot-time sprint run discovery
 * (`sprintengine-boot-discovery.ts`) and the mobile relay's run snapshot.
 *
 * Bounded by construction: only workspaces this Multicode has open contribute a
 * root, so a scan over them is never a walk of the user's home directory.
 */
export function listKnownWorkspaceRoots(snapshot) {
    return uniqueResolvedRoots(snapshot.state.workspaces.map((workspace) => workspace.folderPath));
}
/**
 * Resolve, drop the empty ones, and dedupe, so two spellings of one folder
 * never become two scans.
 */
export function uniqueResolvedRoots(roots) {
    const seen = new Set();
    const unique = [];
    for (const root of roots) {
        if (typeof root !== 'string' || !root.trim())
            continue;
        const resolved = resolve(root);
        if (seen.has(resolved))
            continue;
        seen.add(resolved);
        unique.push(resolved);
    }
    return unique;
}
