// Part of the IPC contract: MCP server configuration, listings and sync.
// ../electron-api.ts re-exports everything here.

import type { McpClientTarget, McpTransport } from './agent-runtime'

export type McpScope = 'workspace' | 'user'
// 'source' is a server a *source* installed (backlog/2026-09-05-plugin-sources.md,
// "Provenance"): it is neither bundled with the app nor typed by hand, and Sync
// owns it. The distinction is what lets a sync overwrite exactly what it wrote
// and nothing else — the same rule `.sprintengine-skill.json` gives skills.
export type McpServerSource = 'bundled' | 'custom' | 'source'
export type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

/**
 * Which source installed a server, which of its items it is, and the commit its
 * declaration was read at. A config carrying this is `source: 'source'`; one
 * without it can never be, so nothing a person typed is ever taken over by a
 * sync.
 */
export type McpServerSourceRef = {
  sourceId: string
  /** The `ScannedMcpServer.id` in that source's scan. */
  itemId: string
  commitSha: string
  /**
   * Set by a sync that re-read the source and no longer found `itemId`. The
   * entry stays and keeps working; the surface says it is no longer in its
   * source rather than deleting a server someone is using.
   */
  missing?: boolean
  /**
   * Where the declaring plugin's own files landed in this workspace, for a
   * server whose command was `${CLAUDE_PLUGIN_ROOT}`-relative. Absent for every
   * other server.
   *
   * Kept on the entry, not looked up: MCP settings are app-level and a sync
   * runs with no workspace open, so this is the only place the re-read knows
   * what to resolve the variable to. Without it the next sync would write the
   * literal token back over a working path
   * (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
   */
  pluginRoot?: string
}

export type McpServerConfig = {
  id: string
  name: string
  category?: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled: boolean
  required?: boolean
  clients: McpClientTarget[]
  scope: McpScope
  source: McpServerSource
  /** Present exactly when `source` is 'source'; see McpServerSourceRef. */
  sourceRef?: McpServerSourceRef
  riskLevel: McpRiskLevel
  auth?: string
  capabilities?: string[]
  sourceUrl?: string
}

export type McpSettings = {
  syncEnabled: boolean
  servers: Record<string, McpServerConfig>
}

/**
 * An MCP server presented for display, without the fields that only a server
 * the person has actually installed can have (`enabled`, `scope`, `source`).
 *
 * Until the third-party retirement (2026-09-08) this was
 * `McpCatalogServer`, the row shape of a bundled MCP catalogue file
 * — a list of 16 servers nobody here wrote. That catalogue is gone and no
 * bundled list replaced it: an MCP server now arrives inside a plugin the
 * person installed from a source. What survives is the presentation shape,
 * because a surface still has to draw an installed server without pretending it
 * knows the settings-owned fields.
 */
export type McpServerListing = Omit<McpServerConfig, 'enabled' | 'scope' | 'source'> & {
  icon?: string
}

export type McpValidationIssue = {
  level: 'error' | 'warning'
  serverId?: string
  client?: McpClientTarget
  message: string
}

export type McpSyncTarget = {
  client: McpClientTarget
  path: string
  serverIds: string[]
}

export type McpSyncPreview =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncResult =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncInput = {
  workspaceRoot: string
  settings: McpSettings
  clients?: McpClientTarget[]
  /**
   * Servers this sync must take OUT of every CLI's config, named because the
   * settings no longer do. A server is pruned from a config only while
   * `settings` still names it, so a caller that has just forgotten one — an
   * uninstalled plugin's, say — has to say so here or the entry survives in
   * `.mcp.json` for good
   * (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).
   */
  forgetServerIds?: string[]
  requiredOnly?: boolean
  write?: boolean
  // Connector-scoped writes are exclusive: the worktree config must end with
  // exactly the servers in this sync (the connector set). Any MCP server the
  // base repo committed into the worktree config is pruned rather than merged,
  // preserving the connector-only isolation contract. Off (default) keeps the
  // normal workspace behavior of merging over the user's configured servers.
  pruneUnlistedServers?: boolean
}
