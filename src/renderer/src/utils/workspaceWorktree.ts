import { samePath } from './paths'
import {
  agentWorktreePaths,
  repoRootFromWorktreePath,
  slugifyWorktreeName,
  workspaceProjectRootOf,
  WORKTREE_CONTAINER_DIR,
  worktreeContainerPath,
} from '../../../shared/worktree-paths'
import type { AgentExecutionMode, Workspace } from '../types/workspace'

// Pure worktree path/branch derivation now lives in the node-free shared module
// so the main process can reuse it (agent-at-launch worktrees over the App
// Automation MCP). Re-exported here so existing renderer import sites are
// untouched.
export {
  agentWorktreePaths,
  repoRootFromWorktreePath,
  slugifyWorktreeName,
  workspaceProjectRootOf,
  WORKTREE_CONTAINER_DIR,
  worktreeContainerPath,
}

/**
 * The project a workspace files under: its own folder, or — for a
 * worktree-backed one — the checkout the worktree was cut from. A worktree chat
 * lives at `<parent>/.multicode-worktrees/<repo>/<slug>`, so grouping by
 * `folderPath` alone would give it a project header of its own named after the
 * slug instead of filing it under the project it belongs to.
 *
 * Single source for grouping, "New chat in project", ordering and forgetting a
 * project. Everything not worktree-backed is its own folder unchanged.
 *
 * The rule itself lives in the shared module because main's registry ordering
 * has to answer the same question about the same records; this is the renderer's
 * `Workspace`-typed door onto it.
 */
export function workspaceProjectRoot(workspace: Pick<Workspace, 'folderPath' | 'worktree'>): string | null {
  return workspaceProjectRootOf(workspace)
}

export type ResolvedWorkspaceWorktree = {
  /** Absolute git root to use for this workspace's Git view. */
  gitRoot: string
  /** Branch the worktree is checked out on, for display. */
  branch?: string
}

/**
 * The worktree this workspace is backed by, or null for a regular workspace.
 *
 * Worktree workspaces (opened via the Worktree manager) are flagged by the
 * explicit `workspace.worktree` marker. Their `folderPath` already *is* the
 * worktree, so the git root stays `folderPath`; the marker only carries the
 * branch and signals worktree-backed. Used by the workspace's Git view default,
 * its terminal glyph, and any terminal spawned into the workspace.
 */
export function resolveWorkspaceWorktree(
  workspace: Pick<Workspace, 'folderPath' | 'worktree'>,
): ResolvedWorkspaceWorktree | null {
  const folderPath = workspace.folderPath
  if (!folderPath || !workspace.worktree) return null
  // Deliberately no project root: the Git panel operates on this checkout (it
  // diffs, stages, commits and spawns its terminal there). The project this
  // worktree was cut from is a grouping fact, and grouping asks
  // workspaceProjectRoot for it.
  return { gitRoot: folderPath, branch: workspace.worktree.branch }
}

/**
 * The workspace's *effective working root*: where live work actually
 * happens. `folderPath` stays the durable primary checkout (that's what
 * `ModuleWorkspaceView` reports), but a worktree-backed workspace does its live
 * work under its worktree — file watches, agent spawns, and file-tab
 * resolution that used the primary checkout would silently miss it. Null means
 * the workspace has no resolvable root at all (folderless), never a fallback.
 */
export function workspaceWorkingRoot(workspace: Pick<Workspace, 'folderPath' | 'worktree'>): string | null {
  return resolveWorkspaceWorktree(workspace)?.gitRoot ?? workspace.folderPath ?? null
}

export type WorkspaceTerminalCwd = { cwd: string; missing: false } | { cwd: null; missing: boolean }

/**
 * Derive the cwd a terminal opened in a worktree-backed workspace should spawn
 * into, given the workspace's PRE-DERIVED git root (from
 * `resolveWorkspaceWorktree(ws)?.gitRoot ?? null`).
 *
 * Taking the string, not the `Workspace`, is deliberate: it forces callers into
 * the churn-safe selector pattern so the value stays referentially stable
 * across the re-projections that recreate the workspace object.
 *
 * - `null` gitRoot → not worktree-backed; no override (`{cwd:null, missing:false}`).
 * - gitRoot === folderPath → the workspace folder already IS the worktree
 *   (worktree-opened / connector-chat workspaces); no override needed.
 * - gitRoot present and on disk → spawn into it (`{cwd:gitRoot, missing:false}`).
 * - gitRoot present but gone → `{cwd:null, missing:true}` so the caller can
 *   surface the removed worktree instead of spawning into a vanished directory.
 */
export async function resolveWorkspaceTerminalCwd(
  worktreeGitRoot: string | null,
  folderPath: string | null,
  pathExists: (path: string) => Promise<boolean>,
): Promise<WorkspaceTerminalCwd> {
  if (!worktreeGitRoot) return { cwd: null, missing: false }
  if (samePath(worktreeGitRoot, folderPath)) return { cwd: null, missing: false }
  if (await pathExists(worktreeGitRoot)) return { cwd: worktreeGitRoot, missing: false }
  return { cwd: null, missing: true }
}

export type WorktreeSpawnFallback = {
  /** True when the agent's worktree cwd was gone and we fell back. */
  fellBack: boolean
  /** The cwd to actually spawn into. */
  cwd: string | undefined
}

/**
 * Guard a worktree-backed agent spawn against a removed run worktree.
 *
 * A worktree agent persists an absolute `execution.cwd` pointing into its
 * worktree. That worktree can be removed out from under the persisted agent
 * (merge cleanup, the Worktree manager, or `git worktree prune`); spawning a
 * terminal into the vanished directory exits with code 1. When the worktree cwd
 * no longer exists, fall back to `fallbackRoot` so the spawn succeeds and
 * flag `fellBack` (callers use it only to redirect this launch and log — they do
 * not persist a change). Non-worktree agents and still-present worktrees pass
 * through unchanged.
 *
 */
export async function resolveWorktreeSpawnFallback(
  executionMode: AgentExecutionMode,
  worktreeCwd: string | undefined,
  fallbackRoot: string | null,
  pathExists: (path: string) => Promise<boolean>,
): Promise<WorktreeSpawnFallback> {
  if (executionMode !== 'worktree' || !worktreeCwd) {
    return { fellBack: false, cwd: worktreeCwd }
  }
  if (await pathExists(worktreeCwd)) {
    return { fellBack: false, cwd: worktreeCwd }
  }
  return { fellBack: true, cwd: fallbackRoot ?? undefined }
}

/** Minimal shape of a Git panel scope option needed to pick the worktree scope. */
export type WorktreeScopeCandidate = {
  id: string
  path: string
  branch: string | null
  missing: boolean
  locked: boolean
  prunable: boolean
}

/**
 * Pick the **healthy** scope that corresponds to a worktree-backed workspace's
 * worktree, used to default the Git panel to the worktree instead of the parent.
 *
 * Matches by path OR by branch: `git worktree list` returns realpath-resolved
 * paths, so a string-joined `gitRoot` can diverge from the listed path under a
 * symlinked project root (e.g. macOS `/tmp` → `/private/tmp`). Branch is unique
 * per worktree (git forbids the same branch in two worktrees) and symlink-
 * independent, so it recovers the match when the path comparison misses.
 *
 * Excludes `missing`/`locked`/`prunable` scopes: returning one of those would
 * fight the panel's validity-reset (which sends such scopes back to `main`),
 * causing an update loop. When the worktree is unhealthy this returns null and
 * the caller falls back to `main`.
 */
export function findHealthyWorktreeScope<T extends WorktreeScopeCandidate>(
  scopes: readonly T[],
  gitRoot: string | null,
  branch: string | null,
): T | null {
  if (!gitRoot && !branch) return null
  return (
    scopes.find(
      (scope) =>
        !scope.missing &&
        !scope.locked &&
        !scope.prunable &&
        ((gitRoot != null && samePath(scope.path, gitRoot)) || (branch != null && scope.branch === branch)),
    ) ?? null
  )
}

// ── Connector chats ──────────────────────────────────────────────────────────
// A "connector chat" is a worktree-isolated solo chat scoped to exactly one MCP
// connector, so the connector server never leaks into the user's other chats.
// These pure helpers build the deterministic pieces of that spawn; the async
// worktree IO around them lives in the launch path.

/** Registry id for a worktree, derived from its absolute path. */
export function worktreeIdFromPath(pathValue: string): string {
  return `worktree-${slugifyWorktreeName(pathValue).replace(/[\\/.:]+/g, '-')}`
}

/** Branch a connector chat's worktree is created on: `connector/<id>-<uid>`. */
export function connectorWorktreeBranch(connectorId: string, uid: string): string {
  return `connector/${connectorId}-${uid}`
}

/** Directory name (under the worktree container) for a connector chat worktree. */
export function connectorWorktreeSlug(connectorId: string, uid: string): string {
  return `${connectorId}-${uid}`
}

/**
 * Wrap a single connector MCP server as a spawn-scoped McpSettings: sync ON (the
 * spawn writes the worktree .mcp.json from it) and exactly that one server — this
 * carries no other MCP, so the spawn's per-worktree config never syncs anything
 * beyond the connector. Never merge this into the global appSettings.mcp.
 *
 * Lives in `src/shared/connector-launch.ts` so the main-process
 * AgentLaunchService writes the identical isolated config headless.
 */
export { connectorMcpSettings } from '../../../shared/connector-launch'
