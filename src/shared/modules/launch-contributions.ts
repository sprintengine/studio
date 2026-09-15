/**
 * A module's contribution to a single agent (or plain-shell) launch.
 *
 * Core calls every registered contribution in module registration order, merges
 * the results, and never lets a throwing contribution fail the launch. Types
 * here are the in-app contract; `@sprintengine/module-sdk` republishes them.
 */

export type LaunchContributionPathStyle = 'posix' | 'windows' | 'wsl'

/**
 * What the host knows about this spawn when it asks modules to contribute.
 *
 * `statePath` and `knowledgeRoot` are values the caller already resolved (a
 * run file, a Knowledge Graph root). Core does not interpret the keys; the
 * module that owns them reads them and writes env / session tags itself.
 */
export type LaunchContributionRequest = {
  cli: string
  workspaceRoot: string
  sessionId: string
  agentId?: string
  agentKind?: string
  resume?: boolean
  /** Absolute run-state path when the caller already resolved one. */
  statePath?: string
  /** Absolute Knowledge Graph root when the launch resolved one. */
  knowledgeRoot?: string
  /**
   * Path style of the launched shell. POSIX env uses `'posix'`; a native
   * Windows PTY uses `'windows'`; a WSL bootstrap uses `'wsl'` so the module
   * can quote paths the Linux shell can open.
   */
  pathStyle: LaunchContributionPathStyle
}

/** One managed-MCP server entry, in the shape `mcp-config-service` already takes. */
export type LaunchContributionMcpServer = {
  id: string
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: string
}

export type LaunchContributionHostContextSection = {
  heading: string
  body: string
}

export type LaunchContributionSessionTag = {
  /** A module owns this session's lifetime (reaper recency-floor exclusion). */
  managed: boolean
  /** Hold this session out of the idle reaper entirely. */
  reapExempt?: boolean
}

export type LaunchContributionResult = {
  env?: Record<string, string>
  /** Directories prepended to `PATH`. The module writes its own shims here. */
  pathEntries?: string[]
  /** POSIX function definitions (and their `export -f`) appended to the shell bootstrap. */
  shellFunctions?: string[]
  mcpServers?: LaunchContributionMcpServer[]
  /** Sections appended to the host-context document after design-system and knowledge. */
  hostContext?: LaunchContributionHostContextSection[]
  session?: LaunchContributionSessionTag
  /**
   * Env keys the shell strips from inherited env before applying this
   * contribution, so a stale value from the app's own process cannot leak
   * into a spawn that did not set its own. Core always strips the
   * agent-identity keys; this list is in addition.
   */
  identityKeys?: string[]
}

export type LaunchContribution = (launch: LaunchContributionRequest) => LaunchContributionResult
