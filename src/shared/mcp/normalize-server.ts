// Pure MCP server-config normalization, shared across processes.
//
// This is the single source of truth for how a raw MCP server object is coerced
// into a valid McpServerConfig (or rejected). It lives in `shared` — with no
// node-only imports — so both the main process (mcp-config-service re-exports
// these) and node-free shared consumers (the marketplace registry validator)
// apply identical rules. Do not add fs/electron/path dependencies here.

import type { McpClientTarget, McpRiskLevel, McpScope, McpServerConfig } from '../electron-api'

export type McpServerNormalizationOptions = {
  clients?: McpClientTarget[]
  enabled?: boolean
  scope?: McpScope
  source?: 'bundled' | 'custom'
  riskLevel?: McpRiskLevel
}

export function normalizeMcpClients(value: McpClientTarget[] | undefined): McpClientTarget[] {
  const clients = (value ?? ['codex', 'claude-code'])
    .map((client) => sanitizeId(client))
    .filter(Boolean)
  return Array.from(new Set(clients))
}

export function normalizeMcpServerConfig(
  value: unknown,
  options: McpServerNormalizationOptions = {}
): McpServerConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<McpServerConfig>
  return normalizeServer({
    ...candidate,
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : options.enabled ?? true,
    clients: Array.isArray(candidate.clients) ? candidate.clients : options.clients,
    scope: candidate.scope ?? options.scope ?? 'workspace',
    source: candidate.source ?? options.source ?? 'custom',
    riskLevel: candidate.riskLevel ?? options.riskLevel,
  } as McpServerConfig)
}

export function normalizeServer(server: McpServerConfig): McpServerConfig | null {
  const id = sanitizeId(server.id)
  if (!id) return null
  const clients = normalizeMcpClients(server.clients)
  if (clients.length === 0) return null
  const transport = server.transport === 'http' || server.transport === 'sse' ? server.transport : 'stdio'
  if (transport === 'stdio' && !server.command?.trim()) return null
  if ((transport === 'http' || transport === 'sse') && !server.url?.trim()) return null
  return {
    ...server,
    id,
    name: server.name?.trim() || id,
    transport,
    command: server.command?.trim(),
    args: Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === 'string') : [],
    url: server.url?.trim(),
    env: normalizeStringRecord(server.env),
    envVarNames: Array.isArray(server.envVarNames) ? server.envVarNames.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()) : [],
    headers: normalizeStringRecord(server.headers),
    clients,
    scope: server.scope === 'user' ? 'user' : 'workspace',
    source: server.source === 'custom' ? 'custom' : 'bundled',
    riskLevel: server.riskLevel === 'network' || server.riskLevel === 'local-command' || server.riskLevel === 'secrets' ? server.riskLevel : 'low',
    category: normalizeOptionalString(server.category),
    auth: normalizeOptionalString(server.auth),
    capabilities: normalizeStringArray(server.capabilities),
    sourceUrl: normalizeOptionalString(server.sourceUrl),
  }
}

export function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[0].trim()))
    .map(([key, item]) => [key.trim(), item] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? Array.from(new Set(items)) : undefined
}

function sanitizeId(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
