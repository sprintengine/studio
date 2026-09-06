// A source's declared MCP server, in the shape MCP settings keep.
//
// One rule, in one place, because two surfaces install a server from a source:
// the plugin install (main, `skills/install-plugin.ts`) and the Add button on a
// source's MCP row (renderer). They wrote the same object twice and drifted —
// the row's copy claimed `source: 'custom'`, which is what a hand-typed server
// is, so Sync could not tell them apart
// (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).
//
// Pure and node-free: main, renderer and tests all import this file.

import type { McpServerConfig, McpServerSourceRef } from '../electron-api'
import type { ScannedMcpServer } from '../skills'

/**
 * `sourceRef` is what makes the entry Sync's to refresh. Omitting it yields a
 * `custom` server — the honest reading of "this came from nowhere the app can
 * re-read", and never a claim a sync would act on.
 */
export function mcpServerConfigFromScanned(
  server: ScannedMcpServer,
  clients: readonly string[],
  sourceRef?: McpServerSourceRef
): McpServerConfig {
  const needsSecrets = server.envVarNames.length > 0
  return {
    id: server.id,
    name: server.name,
    description: server.description || (server.declaredBy ? `Declared by the ${server.declaredBy} plugin.` : undefined),
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    args: server.args,
    ...(server.url ? { url: server.url } : {}),
    env: server.env,
    envVarNames: server.envVarNames,
    headers: server.headers,
    enabled: true,
    required: false,
    clients: [...clients],
    scope: 'workspace',
    ...(sourceRef ? { source: 'source' as const, sourceRef } : { source: 'custom' as const }),
    riskLevel: server.transport === 'stdio' ? 'local-command' : needsSecrets ? 'secrets' : 'network',
  }
}

/** True when this config is one a given source installed — the only kind a sync of it may rewrite. */
export function isOwnedBySource(server: McpServerConfig, sourceId: string): boolean {
  return server.source === 'source' && server.sourceRef?.sourceId === sourceId
}
