import { isAbsoluteFilePath, joinFilePath, pathJoin, pathSeparatorFor, samePath } from './paths'
import {
  agentWorktreePaths,
  slugifyWorktreeName,
  worktreeContainerPath,
} from '../../../shared/worktree-paths'
import { DEFAULT_SPRINTENGINE_TASK_REPO } from '../../../shared/sprintengine/run-types'
import type { AgentExecutionMode, McpServerConfig, McpSettings, Workspace } from '../types/workspace'

// Pure worktree path/branch derivation now lives in the node-free shared module
// so the main process can reuse it (agent-at-launch worktrees over the App
// Automation MCP). Re-exported here so existing renderer import sites are
// untouched.
export { agentWorktreePaths, slugifyWorktreeName, worktreeContainerPath }

export type ResolvedWorkspaceWorktree = {
  /** Absolute git root to use for this workspace's Git view. */
  gitRoot: string
  /** Branch the worktree is checked out on, for display. */
  branch?: string
  /**
   * Declared repo this worktree belongs to (MC-1610), and the absolute root of
   * that repo's own checkout — the tree the worktree was created FROM, which is
   * where a spawn falls back to when the worktree is gone. Absent for a
   * non-sprint worktree workspace, which has no declared repo set.
   */
  repoId?: string
  repoRoot?: string
}

/**
 * Resolve a repo-declared path against the workspace folder. `.` is the
 * workspace folder itself; an absolute value is used as-is (out of contract,
 * but joinFilePath would corrupt it into a nested path).
 *
 * `..` segments are collapsed because a declared sibling root legitimately
 * carries them (`../multicode-mobile`) and this result is compared against real
 * paths — `git worktree list` output, a session's cwd. A string join alone
 * would leave `/proj/../mobile`, which no comparison would ever match.
 * Task-owned paths are a different thing entirely and still reject `..`
 * outright; only a run's own declared roots reach here.
 */
function resolveDeclaredPath(folderPath: string, value: string): string {
  const trimmed = value.trim()
  if (isAbsoluteFilePath(trimmed)) return trimmed
  if (!trimmed || trimmed === '.') return folderPath
  const joined = joinFilePath(folderPath, trimmed)
  if (!joined.includes('..')) return joined
  const separator = pathSeparatorFor(joined)
  const leading = joined.startsWith(separator) ? separator : ''
  const resolved: string[] = []
  for (const segment of joined.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') resolved.pop()
    else resolved.push(segment)
  }
  return leading + resolved.join(separator)
}

/**
 * Every worktree this workspace is backed by, primary first (MC-1610).
 *
 * - Sprint runs in worktree mode: one entry per repo the run declared, derived
 *   from the already-persisted `sprintEngineState.vcs` block. `folderPath` is
 *   the parent project root, so each git root is that repo's project-relative
 *   `worktreePath` joined onto it. A run declaring one repo yields exactly one
 *   entry — the same root and branch the singular resolver always returned. A
 *   pre-`repos` store still normalizes to a one-entry list, so this never falls
 *   back to reading the flat fields itself.
 * - Normal worktree workspaces (opened via the Worktree manager): flagged by the
 *   explicit `workspace.worktree` marker. Their `folderPath` already *is* the
 *   worktree, so the git root stays `folderPath`; the marker only carries the
 *   branch and signals worktree-backed. Always a single entry.
 * - Everything else: empty (regular workspace, unchanged behavior).
 *
 * The Git panel builds one scope per entry; the spawn path selects the entry
 * matching a session's repo. Callers that want "the" worktree take the primary
 * via {@link resolveWorkspaceWorktree}.
 */
export function resolveWorkspaceWorktrees(
  workspace: Pick<Workspace, 'folderPath' | 'worktree' | 'sprintEngineState'>
): ResolvedWorkspaceWorktree[] {
  const folderPath = workspace.folderPath
  if (!folderPath) return []

  const vcs = workspace.sprintEngineState?.vcs
  if (vcs?.mode === 'run_worktree') {
    const resolved = (vcs.repos ?? [])
      .filter((repo) => Boolean(repo.worktreePath))
      .map((repo) => ({
        gitRoot: resolveDeclaredPath(folderPath, repo.worktreePath),
        branch: repo.branchName || vcs.branchName,
        repoId: repo.id,
        repoRoot: resolveDeclaredPath(folderPath, repo.root || '.'),
      }))
    if (resolved.length > 0) return resolved
    // A store whose `repos` list is empty or worktree-less still describes its
    // one worktree with the flat fields; the primary repo of such a run is the
    // workspace itself.
    if (vcs.worktreePath) {
      return [{
        gitRoot: resolveDeclaredPath(folderPath, vcs.worktreePath),
        branch: vcs.branchName,
        repoId: DEFAULT_SPRINTENGINE_TASK_REPO,
        repoRoot: folderPath,
      }]
    }
    return []
  }

  if (workspace.worktree) {
    return [{ gitRoot: folderPath, branch: workspace.worktree.branch }]
  }

  return []
}

/**
 * The workspace's PRIMARY worktree — entry zero of {@link
 * resolveWorkspaceWorktrees} — for the surfaces that show or spawn into exactly
 * one: the workspace's Git view default, its terminal glyph, and any terminal
 * not routed to a specific repo. Null for a regular workspace.
 */
export function resolveWorkspaceWorktree(
  workspace: Pick<Workspace, 'folderPath' | 'worktree' | 'sprintEngineState'>
): ResolvedWorkspaceWorktree | null {
  return resolveWorkspaceWorktrees(workspace)[0] ?? null
}

/**
 * The root a spawn falls back to when `worktreeCwd` has been removed: the root
 * of the repo THAT worktree belongs to, not the workspace folder (MC-1610). A
 * pruned mobile worktree redirects into the mobile checkout, where the agent's
 * repo-relative paths still mean what they say; redirecting it into the
 * workspace root would silently point it at a different project's files.
 *
 * The workspace folder remains the answer for the primary repo (whose root IS
 * the workspace) and for any cwd that matches no declared worktree.
 */
export function resolveWorktreeFallbackRoot(
  workspace: Pick<Workspace, 'folderPath' | 'worktree' | 'sprintEngineState'>,
  worktreeCwd: string | null | undefined
): string | null {
  const folderPath = workspace.folderPath ?? null
  if (!worktreeCwd) return folderPath
  const match = resolveWorkspaceWorktrees(workspace).find((entry) => samePath(entry.gitRoot, worktreeCwd))
  return match?.repoRoot ?? folderPath
}

export type WorkspaceTerminalCwd =
  | { cwd: string; missing: false }
  | { cwd: null; missing: boolean }

/**
 * Derive the cwd a terminal opened in a worktree-backed workspace should spawn
 * into, given the workspace's PRE-DERIVED git root (from
 * `resolveWorkspaceWorktree(ws)?.gitRoot ?? null`).
 *
 * Taking the string, not the `Workspace`, is deliberate: it forces callers into
 * the churn-safe selector pattern so the value stays referentially stable across
 * the ~4s `sprintEngineState` re-projections that recreate the workspace object.
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
 * Sprint agents persist an absolute `execution.cwd` pointing into their repo's
 * run worktree. That worktree can be removed out from under the persisted agent
 * (merge cleanup, the Worktree manager, or `git worktree prune`); spawning a
 * terminal into the vanished directory exits with code 1. When the worktree cwd
 * no longer exists, fall back to `fallbackRoot` so the spawn succeeds and
 * flag `fellBack` (callers use it only to redirect this launch and log — they do
 * not persist a change). Non-worktree agents and still-present worktrees pass
 * through unchanged.
 *
 * `fallbackRoot` is per-repo (MC-1610) — {@link resolveWorktreeFallbackRoot}
 * derives it from the vanished worktree's own declared repo, so a pruned mobile
 * worktree redirects into the mobile checkout rather than the workspace root.
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
        !scope.missing
        && !scope.locked
        && !scope.prunable
        && (
          (gitRoot != null && samePath(scope.path, gitRoot))
          || (branch != null && scope.branch === branch)
        ),
    ) ?? null
  )
}

// ── Connector chats ──────────────────────────────────────────────────────────
// A "connector chat" is a worktree-isolated solo chat scoped to exactly one MCP
// connector (e.g. Railway) plus its driving skill, so the connector server never
// leaks into the user's other chats. These pure helpers build the deterministic
// pieces of that spawn; the async worktree/catalog IO around them lives in
// WorkspaceManager.launchConnectorChat.

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
 * Resolve the git worktree location for a new connector chat off `repoRoot`,
 * placing it under the same container the Worktree manager uses so every
 * worktree for a repo lives in one folder.
 */
export function connectorWorktreePaths(
  repoRoot: string,
  connectorId: string,
  uid: string,
): { containerPath: string; destinationPath: string; slug: string; branchName: string } {
  const slug = connectorWorktreeSlug(connectorId, uid)
  const containerPath = worktreeContainerPath(repoRoot)
  return {
    containerPath,
    destinationPath: pathJoin(containerPath, slug),
    slug,
    branchName: connectorWorktreeBranch(connectorId, uid),
  }
}

/**
 * Wrap a single connector MCP server as a spawn-scoped McpSettings: sync ON (the
 * spawn writes the worktree .mcp.json from it) and exactly that one server — this
 * carries no other MCP, so the spawn's per-worktree config never syncs anything
 * beyond the connector. Never merge this into the global appSettings.mcp.
 */
export function connectorMcpSettings(server: McpServerConfig): McpSettings {
  return { syncEnabled: true, servers: { [server.id]: server } }
}

/** The seeded first turn: the skill invocation (when available) then the instruction. */
export function connectorStartupPrompt(invocation: string | undefined, instruction: string): string {
  return invocation ? `${invocation}\n\n${instruction}` : instruction
}
