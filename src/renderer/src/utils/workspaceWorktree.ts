import { basename, isAbsoluteFilePath, joinFilePath, parentPath, pathJoin, samePath } from './paths'
import type { AgentExecutionMode, McpServerConfig, McpSettings, Workspace } from '../types/workspace'
import type { PluginSkillCatalog } from '../../../shared/plugin-manifest'

export type ResolvedWorkspaceWorktree = {
  /** Absolute git root to use for this workspace's Git view. */
  gitRoot: string
  /** Branch the worktree is checked out on, for display. */
  branch?: string
}

/**
 * Single source of truth for "is this workspace backed by a git worktree, and
 * if so what git root + branch should its Git view and terminal glyph use".
 *
 * - Sprint runs in worktree mode: derived from the already-persisted
 *   `sprintEngineState.vcs` block. `folderPath` is the parent project root, so
 *   the git root is redirected to the run worktree (project-relative
 *   `worktreePath` joined onto `folderPath`). No new persisted data.
 * - Normal worktree workspaces (opened via the Worktree manager): flagged by the
 *   explicit `workspace.worktree` marker. Their `folderPath` already *is* the
 *   worktree, so the git root stays `folderPath`; the marker only carries the
 *   branch and signals worktree-backed.
 * - Everything else: null (regular workspace, unchanged behavior).
 */
export function resolveWorkspaceWorktree(
  workspace: Pick<Workspace, 'folderPath' | 'worktree' | 'sprintEngineState'>
): ResolvedWorkspaceWorktree | null {
  const folderPath = workspace.folderPath
  if (!folderPath) return null

  const vcs = workspace.sprintEngineState?.vcs
  if (vcs?.mode === 'run_worktree' && vcs.worktreePath) {
    // `worktreePath` is project-root-relative by contract; guard against an
    // absolute value (which joinFilePath would corrupt into a nested path).
    const gitRoot = isAbsoluteFilePath(vcs.worktreePath)
      ? vcs.worktreePath
      : joinFilePath(folderPath, vcs.worktreePath)
    return { gitRoot, branch: vcs.branchName }
  }

  if (workspace.worktree) {
    return { gitRoot: folderPath, branch: workspace.worktree.branch }
  }

  return null
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
 * Sprint agents persist an absolute `execution.cwd` pointing into the shared run
 * worktree. That worktree can be removed out from under the persisted agent
 * (merge cleanup, the Worktree manager, or `git worktree prune`); spawning a
 * terminal into the vanished directory exits with code 1. When the worktree cwd
 * no longer exists, fall back to the workspace folder so the spawn succeeds and
 * flag `fellBack` (callers use it only to redirect this launch and log — they do
 * not persist a change). Non-worktree agents and still-present worktrees pass
 * through unchanged.
 */
export async function resolveWorktreeSpawnFallback(
  executionMode: AgentExecutionMode,
  worktreeCwd: string | undefined,
  workspaceFolderPath: string | null,
  pathExists: (path: string) => Promise<boolean>,
): Promise<WorktreeSpawnFallback> {
  if (executionMode !== 'worktree' || !worktreeCwd) {
    return { fellBack: false, cwd: worktreeCwd }
  }
  if (await pathExists(worktreeCwd)) {
    return { fellBack: false, cwd: worktreeCwd }
  }
  return { fellBack: true, cwd: workspaceFolderPath ?? undefined }
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
// WorkspaceManager.createConnectorChat.

/** Directory holding all of a repo's worktrees — shared with the Worktree manager. */
const WORKTREE_CONTAINER_DIR = '.multicode-worktrees'

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
  const containerPath = pathJoin(parentPath(repoRoot), WORKTREE_CONTAINER_DIR, basename(repoRoot))
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

/**
 * The CLI-native explicit invocation for a connector's skill (e.g. `/use-railway`
 * for Claude, `Use $use-railway.` for Codex), read from the CLI plugin's declared
 * skill-invocation template. Undefined when the plugin declares no native skill
 * support or template, so the caller falls back to the plain instruction.
 */
export function connectorSkillInvocation(
  skillIntegration: PluginSkillCatalog | undefined,
  skillId: string,
): string | undefined {
  if (!skillIntegration || skillIntegration.support !== 'native') return undefined
  const template = skillIntegration.invocation?.explicitTemplate
  if (!template) return undefined
  return template.replace(/\{\{\s*skillId\s*\}\}/g, skillId)
}

/** The seeded first turn: the skill invocation (when available) then the instruction. */
export function connectorStartupPrompt(invocation: string | undefined, instruction: string): string {
  return invocation ? `${invocation}\n\n${instruction}` : instruction
}
