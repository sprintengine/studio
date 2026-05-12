import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, delimiter, isAbsolute, join } from 'path'
import type {
  AgentCli,
  McpCatalogResult,
  McpCatalogServer,
  McpClientTarget,
  McpScope,
  McpServerConfig,
  McpSettings,
  McpSyncInput,
  McpSyncPreview,
  McpSyncResult,
  McpSyncTarget,
  McpValidationIssue,
} from '../shared/electron-api'

const MANAGED_START = '# >>> multicode mcp managed'
const MANAGED_END = '# <<< multicode mcp managed'

export type McpConfigService = {
  listCatalog(): McpCatalogResult
  previewSync(input: McpSyncInput): McpSyncPreview
  sync(input: McpSyncInput): McpSyncResult
}

export function createMcpConfigService(): McpConfigService {
  return {
    listCatalog,
    previewSync: (input) => syncMcpConfig({ ...input, write: false }),
    sync: (input) => syncMcpConfig({ ...input, write: true }),
  }
}

function listCatalog(): McpCatalogResult {
  try {
    const catalogPath = findCatalogPath()
    if (!catalogPath) {
      return { ok: false, message: 'Bundled MCP catalog was not found.' }
    }
    const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as { servers?: unknown }
    if (!Array.isArray(raw.servers)) {
      return { ok: false, message: 'Bundled MCP catalog is missing its servers array.' }
    }
    const servers = raw.servers
      .map(normalizeCatalogServer)
      .filter((server): server is McpCatalogServer => Boolean(server))
    return { ok: true, servers }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unable to read bundled MCP catalog.',
    }
  }
}

function findCatalogPath(): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'mcps', 'catalog.json'),
        join(app.getAppPath(), 'resources', 'mcps', 'catalog.json'),
      ]
    : [
        join(process.cwd(), 'resources', 'mcps', 'catalog.json'),
        join(app.getAppPath(), 'resources', 'mcps', 'catalog.json'),
        join(__dirname, '..', '..', 'resources', 'mcps', 'catalog.json'),
        join(__dirname, '..', '..', '..', 'resources', 'mcps', 'catalog.json'),
      ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function syncMcpConfig(input: McpSyncInput): McpSyncResult {
  const settings = normalizeSettings(input.settings)
  const clients = normalizeClients(input.clients)
  const issues: McpValidationIssue[] = []
  if (!settings.syncEnabled) {
    return { ok: true, targets: [], issues }
  }
  if (!input.workspaceRoot || !existsSync(input.workspaceRoot)) {
    return { ok: false, message: 'Workspace root does not exist.', issues }
  }

  const activeServers = Object.values(settings.servers)
    .filter((server) => server.enabled)
    .filter((server) => clients.some((client) => server.clients.includes(client)))

  for (const server of activeServers) {
    issues.push(...validateServer(server))
  }

  const blocking = issues.find((issue) => issue.level === 'error')
  if (blocking) {
    return { ok: false, message: blocking.message, issues }
  }

  const targets: McpSyncTarget[] = []
  for (const client of clients) {
    const clientServers = activeServers.filter((server) => server.clients.includes(client))
    const knownClientServerIds = Object.values(settings.servers)
      .filter((server) => server.clients.includes(client))
      .map((server) => server.id)
    if (clientServers.length === 0 && knownClientServerIds.length === 0) continue
    if (client === 'codex') {
      const target = syncCodex(input.workspaceRoot, clientServers, input.write === true)
      targets.push(target)
      continue
    }
    const claudeResult = syncClaude(input.workspaceRoot, clientServers, knownClientServerIds, input.write === true)
    targets.push(claudeResult.target)
    issues.push(...claudeResult.issues)
  }

  const syncBlocking = issues.find((issue) => issue.level === 'error')
  if (syncBlocking) {
    return { ok: false, message: syncBlocking.message, issues }
  }

  return { ok: true, targets, issues }
}

function normalizeClients(value: McpClientTarget[] | undefined): McpClientTarget[] {
  const clients = (value ?? ['codex', 'claude']).filter((client): client is AgentCli => client === 'codex' || client === 'claude')
  return Array.from(new Set(clients))
}

function normalizeSettings(settings: McpSettings | undefined): McpSettings {
  if (!settings || typeof settings !== 'object') return { syncEnabled: false, servers: {} }
  const servers: Record<string, McpServerConfig> = {}
  for (const value of Object.values(settings.servers ?? {})) {
    if (!value || typeof value !== 'object') continue
    const normalized = normalizeServer(value)
    if (normalized) servers[normalized.id] = normalized
  }
  return {
    syncEnabled: settings.syncEnabled === true,
    servers,
  }
}

function normalizeServer(server: McpServerConfig): McpServerConfig | null {
  const id = sanitizeId(server.id)
  if (!id) return null
  const clients = normalizeClients(server.clients)
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

function normalizeCatalogServer(value: unknown): McpCatalogServer | null {
  const server = normalizeServer({
    ...(value as McpServerConfig),
    enabled: false,
    scope: ((value as Partial<McpCatalogServer>)?.recommendedScope ?? 'workspace') as McpScope,
    source: 'bundled',
  })
  if (!server) return null
  const candidate = value as Partial<McpCatalogServer>
  return {
    ...server,
    defaultClients: normalizeClients(candidate.defaultClients ?? server.clients),
    recommendedScope: candidate.recommendedScope === 'user' ? 'user' : 'workspace',
    setupNotes: typeof candidate.setupNotes === 'string' ? candidate.setupNotes : undefined,
  }
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

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[0].trim()))
    .map(([key, item]) => [key.trim(), item] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function sanitizeId(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function validateServer(server: McpServerConfig): McpValidationIssue[] {
  const issues: McpValidationIssue[] = []
  if (server.transport === 'stdio') {
    const command = server.command?.trim()
    if (!command) {
      issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a command.` })
    } else if (!commandExists(command)) {
      issues.push({ level: server.required ? 'error' : 'warning', serverId: server.id, message: `${server.name} command was not found: ${command}` })
    }
  }
  if ((server.transport === 'http' || server.transport === 'sse') && !server.url?.trim()) {
    issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a URL.` })
  }
  for (const envVar of server.envVarNames ?? []) {
    if (!process.env[envVar]) {
      issues.push({ level: server.required ? 'error' : 'warning', serverId: server.id, message: `${server.name} expects environment variable ${envVar}.` })
    }
  }
  return issues
}

function commandExists(command: string): boolean {
  if (isAbsolute(command)) return existsSync(command)
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const names = process.platform === 'win32'
    ? [command, `${command}.cmd`, `${command}.exe`, `${command}.ps1`]
    : [command]
  return pathValue.split(delimiter).some((dir) => names.some((name) => existsSync(join(dir, name))))
}

function targetPath(client: McpClientTarget, scope: McpScope, workspaceRoot: string): string {
  if (client === 'codex') {
    return scope === 'user'
      ? join(app.getPath('home'), '.codex', 'config.toml')
      : join(workspaceRoot, '.codex', 'config.toml')
  }
  return join(workspaceRoot, '.mcp.json')
}

function syncCodex(workspaceRoot: string, servers: McpServerConfig[], write: boolean): McpSyncTarget {
  const scope = servers.some((server) => server.scope === 'user') ? 'user' : 'workspace'
  const path = targetPath('codex', scope, workspaceRoot)
  if (write) {
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, replaceManagedBlock(previous, renderCodexManagedBlock(servers)), 'utf8')
  }
  return { client: 'codex', path, serverIds: servers.map((server) => server.id) }
}

function syncClaude(
  workspaceRoot: string,
  servers: McpServerConfig[],
  knownServerIds: string[],
  write: boolean
): { target: McpSyncTarget; issues: McpValidationIssue[] } {
  const workspaceServers = servers.filter((server) => server.scope === 'workspace')
  const userServers = servers.filter((server) => server.scope === 'user')
  const issues = userServers.map((server): McpValidationIssue => ({
    level: server.required ? 'error' : 'warning',
    client: 'claude',
    serverId: server.id,
    message: `Claude user-scoped MCP sync is not implemented yet for ${server.name}; use workspace scope or claude mcp add.`,
  }))
  const path = targetPath('claude', 'workspace', workspaceRoot)
  if (write && (workspaceServers.length > 0 || knownServerIds.length > 0)) {
    mkdirSync(dirname(path), { recursive: true })
    let existing: Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      } catch {
        issues.push({
          level: 'error',
          client: 'claude',
          message: `.mcp.json is not valid JSON. Fix it before syncing Claude MCPs.`,
        })
        return {
          target: { client: 'claude', path, serverIds: workspaceServers.map((server) => server.id) },
          issues,
        }
      }
    }
    const currentServers = existing.mcpServers && typeof existing.mcpServers === 'object'
      ? existing.mcpServers as Record<string, unknown>
      : {}
    const nextServers = { ...currentServers }
    for (const serverId of knownServerIds) {
      delete nextServers[serverId]
    }
    for (const server of workspaceServers) {
      nextServers[server.id] = toClaudeServer(server)
    }
    writeFileSync(path, `${JSON.stringify({ ...existing, mcpServers: nextServers }, null, 2)}\n`, 'utf8')
  }
  return {
    target: { client: 'claude', path, serverIds: workspaceServers.map((server) => server.id) },
    issues,
  }
}

function replaceManagedBlock(previous: string, block: string): string {
  const pattern = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, 'm')
  const trimmed = previous.replace(pattern, '').trimEnd()
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`
}

function renderCodexManagedBlock(servers: McpServerConfig[]): string {
  return [
    MANAGED_START,
    '# This section is generated by Multicode Settings. Edit MCPs in Multicode or remove this block.',
    ...servers.flatMap(renderCodexServer),
    MANAGED_END,
  ].join('\n')
}

function renderCodexServer(server: McpServerConfig): string[] {
  const lines = [`[mcp_servers.${server.id}]`]
  if (server.transport === 'stdio') {
    lines.push(`command = ${tomlString(server.command ?? '')}`)
    if (server.args?.length) lines.push(`args = [${server.args.map(tomlString).join(', ')}]`)
    if (server.envVarNames?.length) lines.push(`env_vars = [${server.envVarNames.map(tomlString).join(', ')}]`)
    if (server.env) lines.push(`env = { ${Object.entries(server.env).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`)
  } else {
    lines.push(`url = ${tomlString(server.url ?? '')}`)
    if (server.envVarNames?.length) lines.push(`bearer_token_env_var = ${tomlString(server.envVarNames[0])}`)
    if (server.headers) lines.push(`http_headers = { ${Object.entries(server.headers).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`)
  }
  lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`)
  if (server.required) lines.push('required = true')
  return ['', ...lines]
}

function toClaudeServer(server: McpServerConfig): Record<string, unknown> {
  if (server.transport === 'stdio') {
    return {
      type: 'stdio',
      command: process.platform === 'win32' && server.command === 'npx' ? 'cmd' : server.command,
      args: process.platform === 'win32' && server.command === 'npx'
        ? ['/c', 'npx', ...(server.args ?? [])]
        : server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    }
  }
  return {
    type: server.transport === 'sse' ? 'sse' : 'http',
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
