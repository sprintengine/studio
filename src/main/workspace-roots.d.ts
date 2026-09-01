import type { WorkspaceSyncSnapshot } from '../shared/workspace-sync';
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
export declare function listKnownWorkspaceRoots(snapshot: WorkspaceSyncSnapshot): string[];
/**
 * Resolve, drop the empty ones, and dedupe, so two spellings of one folder
 * never become two scans.
 */
export declare function uniqueResolvedRoots(roots: ReadonlyArray<string | null | undefined>): string[];
