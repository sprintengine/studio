import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, delimiter, isAbsolute, join } from 'path'

// Lazy electron so the module is importable from node-only test bundles.
function loadElectron(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}
import type {
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
import type { PluginManifest, PluginMcpConfigSpec } from '../shared/plugin-manifest'
import { pluginIdForCli } from './agent-launch-render'
import { getPluginById } from './plugin-registry-instance'

const MANAGED_START = '# >>> multicode mcp managed'
const MANAGED_END = '# <<< multicode mcp managed'
export const MANAGED_SPRINTENGINE_MCP_SERVER_ID = 'multicode-sprintengine'
const MANAGED_MISSING_COMMAND_PREFIX = '__missing_multicode_sprintengine_mcp__:'

export type PluginLookup = (id: string) => { manifest: PluginManifest } | undefined

export type McpConfigService = {
  listCatalog(): McpCatalogResult
  previewSync(input: McpSyncInput): McpSyncPreview
  sync(input: McpSyncInput): McpSyncResult
  removeManagedSprintEngine(input: McpManagedSprintEngineRemoveInput): McpSyncResult
}

export type McpConfigServiceOptions = {
  lookupPlugin?: PluginLookup
  homeDir?: () => string
  userDataDir?: () => string
  runtimeRoot?: () => string | null
}

export function createMcpConfigService(options: McpConfigServiceOptions = {}): McpConfigService {
  const lookupPlugin: PluginLookup = options.lookupPlugin ?? ((id) => getPluginById(id))
  const homeDir = options.homeDir ?? (() => homedir())
  const userDataDir = options.userDataDir ?? (() => defaultUserDataDir(homeDir))
  const runtimeRoot = options.runtimeRoot ?? findSprintEngineRuntimeRoot
  return {
    listCatalog,
    previewSync: (input) => syncMcpConfig({ ...input, write: false }, { lookupPlugin, homeDir, userDataDir, runtimeRoot }),
    sync: (input) => syncMcpConfig({ ...input, write: true }, { lookupPlugin, homeDir, userDataDir, runtimeRoot }),
    removeManagedSprintEngine: (input) => removeManagedSprintEngineConfig(input, { lookupPlugin, homeDir, userDataDir, runtimeRoot }),
  }
}

export type McpManagedSprintEngineRemoveInput = {
  workspaceRoot: string
  clients?: McpClientTarget[]
}

type SyncContext = {
  lookupPlugin: PluginLookup
  homeDir: () => string
  userDataDir: () => string
  runtimeRoot: () => string | null
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
  const electron = loadElectron()
  const candidates = electron.app.isPackaged
    ? [
        join(process.resourcesPath, 'mcps', 'catalog.json'),
        join(electron.app.getAppPath(), 'resources', 'mcps', 'catalog.json'),
      ]
    : [
        join(process.cwd(), 'resources', 'mcps', 'catalog.json'),
        join(electron.app.getAppPath(), 'resources', 'mcps', 'catalog.json'),
        join(__dirname, '..', '..', 'resources', 'mcps', 'catalog.json'),
        join(__dirname, '..', '..', '..', 'resources', 'mcps', 'catalog.json'),
      ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function syncMcpConfig(input: McpSyncInput, context: SyncContext): McpSyncResult {
  const managedServer = buildManagedSprintEngineServer(input)
  const settings = normalizeSettings(input.settings, managedServer)
  const clients = normalizeClients(input.clients)
  const issues: McpValidationIssue[] = []
  if (!settings.syncEnabled && !managedServer) {
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

    const pluginId = pluginIdForCli(client)
    const plugin = context.lookupPlugin(pluginId)
    if (!plugin || !plugin.manifest.mcpConfig) {
      const hasRequired = clientServers.some((server) => server.required)
      issues.push({
        level: hasRequired ? 'error' : 'warning',
        client,
        message: hasRequired
          ? `Plugin "${pluginId}" does not support HTTP MCP config sync; Sprint Engine autonomous mode requires an HTTP MCP-capable plugin with an mcpConfig block.`
          : `Plugin "${pluginId}" does not declare an mcpConfig block; skipping MCP sync for this CLI.`,
      })
      continue
    }
    if (plugin.manifest.capabilities.mcpServers !== true) {
      const hasRequired = clientServers.some((server) => server.required)
      issues.push({
        level: hasRequired ? 'error' : 'warning',
        client,
        message: hasRequired
          ? `Plugin "${pluginId}" does not support HTTP MCP servers; Sprint Engine autonomous mode requires HTTP MCP support via capabilities.mcpServers.`
          : `Plugin "${pluginId}" does not declare MCP server support; skipping MCP sync for this CLI.`,
      })
      continue
    }

    const formatTargets = syncForFormat({
      client,
      plugin: plugin.manifest,
      workspaceRoot: input.workspaceRoot,
      servers: clientServers,
      knownServerIds: knownClientServerIds,
      write: input.write === true,
      context,
    })
    targets.push(...formatTargets.targets)
    issues.push(...formatTargets.issues)
  }

  const syncBlocking = issues.find((issue) => issue.level === 'error')
  if (syncBlocking) {
    return { ok: false, message: syncBlocking.message, issues }
  }

  return { ok: true, targets, issues }
}

function removeManagedSprintEngineConfig(input: McpManagedSprintEngineRemoveInput, context: SyncContext): McpSyncResult {
  const clients = normalizeClients(input.clients)
  const issues: McpValidationIssue[] = []
  if (!input.workspaceRoot || !existsSync(input.workspaceRoot)) {
    return { ok: false, message: 'Workspace root does not exist.', issues }
  }

  const targets: McpSyncTarget[] = []
  for (const client of clients) {
    const pluginId = pluginIdForCli(client)
    const plugin = context.lookupPlugin(pluginId)
    if (!plugin?.manifest.mcpConfig || plugin.manifest.capabilities.mcpServers !== true) continue
    const formatTargets = syncForFormat({
      client,
      plugin: plugin.manifest,
      workspaceRoot: input.workspaceRoot,
      servers: [],
      knownServerIds: [MANAGED_SPRINTENGINE_MCP_SERVER_ID],
      write: true,
      context,
    })
    targets.push(...formatTargets.targets)
    issues.push(...formatTargets.issues)
  }

  const blocking = issues.find((issue) => issue.level === 'error')
  if (blocking) return { ok: false, message: blocking.message, issues }
  return { ok: true, targets, issues }
}

function normalizeClients(value: McpClientTarget[] | undefined): McpClientTarget[] {
  const clients = (value ?? ['codex', 'claude-code'])
    .map((client) => sanitizeId(client))
    .filter(Boolean)
  return Array.from(new Set(clients))
}

function buildManagedSprintEngineServer(input: McpSyncInput): McpServerConfig | null {
  const managed = input.managedSprintEngine
  if (!managed?.statePath?.trim()) return null
  const clients = normalizeClients(input.clients)
  if (managed.http?.url?.trim()) {
    return {
      id: MANAGED_SPRINTENGINE_MCP_SERVER_ID,
      name: 'Multicode Sprint Engine',
      description: 'Managed local Sprint Engine MCP server for autonomous Sprint Engine agent sessions.',
      transport: 'http',
      url: managed.http.url.trim(),
      envVarNames: managed.http.authTokenEnvVar?.trim() ? [managed.http.authTokenEnvVar.trim()] : [],
      headers: normalizeStringRecord(managed.http.headers),
      enabled: true,
      required: true,
      clients,
      scope: 'workspace',
      source: 'bundled',
      riskLevel: 'local-command',
      capabilities: ['sprintengine'],
    }
  }
  return missingManagedSprintEngineServer(
    'Managed Sprint Engine HTTP MCP connection was not supplied; autonomous Sprint Engine agents require an app-owned HTTP MCP run.',
    clients
  )
}

function missingManagedSprintEngineServer(message: string, clients: McpClientTarget[]): McpServerConfig {
  return {
    id: MANAGED_SPRINTENGINE_MCP_SERVER_ID,
    name: 'Multicode Sprint Engine',
    transport: 'stdio',
    command: `${MANAGED_MISSING_COMMAND_PREFIX}${message}`,
    args: [],
    enabled: true,
    required: true,
    clients,
    scope: 'workspace',
    source: 'bundled',
    riskLevel: 'local-command',
  }
}

export function findSprintEngineRuntimeRoot(): string | null {
  const candidates = [
    process.cwd(),
    maybeResourcesPath(),
    maybeAppPath(),
    join(__dirname, '..', '..'),
    join(__dirname, '..', '..', '..'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) =>
    existsSync(join(candidate, 'sprintengine_mcp', 'server.py'))
    && existsSync(join(candidate, 'sprintengine_core'))
  ) ?? null
}

function maybeResourcesPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath || null
}

function maybeAppPath(): string | null {
  try {
    const electron = loadElectron()
    return electron.app?.getAppPath?.() ?? null
  } catch {
    return null
  }
}

function defaultUserDataDir(homeDir: () => string): string {
  try {
    const electron = loadElectron()
    const userData = electron.app?.getPath?.('userData')
    if (userData) return userData
  } catch {
    // Node-only tests do not provide Electron's app object.
  }
  return join(homeDir(), '.multicode')
}

function normalizeSettings(settings: McpSettings | undefined, managedServer?: McpServerConfig | null): McpSettings {
  if (!settings || typeof settings !== 'object') {
    return {
      syncEnabled: Boolean(managedServer),
      servers: managedServer ? { [managedServer.id]: managedServer } : {},
    }
  }
  const servers: Record<string, McpServerConfig> = {}
  for (const value of Object.values(settings.servers ?? {})) {
    if (!value || typeof value !== 'object') continue
    const normalized = normalizeServer(value)
    if (normalized) servers[normalized.id] = normalized
  }
  if (managedServer) {
    servers[managedServer.id] = managedServer
  }
  return {
    syncEnabled: settings.syncEnabled === true || Boolean(managedServer),
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
    } else if (command.startsWith(MANAGED_MISSING_COMMAND_PREFIX)) {
      issues.push({
        level: 'error',
        serverId: server.id,
        message: command.slice(MANAGED_MISSING_COMMAND_PREFIX.length),
      })
    } else if (!commandExists(command)) {
      issues.push({ level: server.required ? 'error' : 'warning', serverId: server.id, message: `${server.name} command was not found: ${command}` })
    }
  }
  if ((server.transport === 'http' || server.transport === 'sse') && !server.url?.trim()) {
    issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a URL.` })
  }
  if (server.id === MANAGED_SPRINTENGINE_MCP_SERVER_ID && server.transport === 'http' && !server.envVarNames?.[0]) {
    issues.push({
      level: 'error',
      serverId: server.id,
      message: `${server.name} requires an env-backed bearer token for managed Sprint Engine HTTP MCP launches.`,
    })
  }
  for (const envVar of server.envVarNames ?? []) {
    if (server.id === MANAGED_SPRINTENGINE_MCP_SERVER_ID && server.transport === 'http') {
      continue
    }
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

function resolveMcpTargetPath(
  spec: PluginMcpConfigSpec,
  scope: McpScope,
  workspaceRoot: string,
  homeDir: () => string
): string | null {
  const template = scope === 'user' ? spec.userPath : spec.path
  if (!template) return null
  const substituted = template
    .replace(/\{\{\s*workspaceRoot\s*\}\}/g, workspaceRoot)
    .replace(/\{\{\s*home\s*\}\}/g, homeDir())
    .replace(/^~(?=\/|$)/, homeDir())
  return substituted
}

type SyncForFormatInput = {
  client: McpClientTarget
  plugin: PluginManifest
  workspaceRoot: string
  servers: McpServerConfig[]
  knownServerIds: string[]
  write: boolean
  context: SyncContext
}

function syncForFormat(input: SyncForFormatInput): {
  targets: McpSyncTarget[]
  issues: McpValidationIssue[]
} {
  const format = input.plugin.mcpConfig!.format
  switch (format) {
    case 'codex':
      return {
        targets: [syncCodex(input)],
        issues: [],
      }
    case 'claude-code': {
      const result = syncClaude(input)
      return { targets: [result.target], issues: result.issues }
    }
    case 'opencode':
    case 'generic': {
      const hasRequired = input.servers.some((server) => server.required)
      return {
        targets: [],
        issues: [
          {
            level: hasRequired ? 'error' : 'warning',
            client: input.client,
            message: hasRequired
              ? `MCP sync writer for format "${format}" is not implemented yet; Sprint Engine autonomous mode requires an HTTP MCP-capable config writer with env-backed bearer token support for plugin "${input.plugin.id}".`
              : `MCP sync writer for format "${format}" is not implemented yet; declared in plugin "${input.plugin.id}".`,
          },
        ],
      }
    }
  }
}

function syncCodex(input: SyncForFormatInput): McpSyncTarget {
  const { plugin, servers, knownServerIds, workspaceRoot, write, context, client } = input
  const scope: McpScope = servers.some((server) => server.scope === 'user') ? 'user' : 'workspace'
  const resolved = resolveMcpTargetPath(plugin.mcpConfig!, scope, workspaceRoot, context.homeDir)
  if (!resolved) {
    return { client, path: '', serverIds: servers.map((server) => server.id) }
  }
  if (write && (servers.length > 0 || knownServerIds.length > 0)) {
    const previous = existsSync(resolved) ? readFileSync(resolved, 'utf8') : ''
    mkdirSync(dirname(resolved), { recursive: true })
    writeFileSync(
      resolved,
      servers.length ? replaceManagedBlock(previous, renderCodexManagedBlock(servers)) : removeCodexManagedServers(previous, knownServerIds),
      'utf8'
    )
  }
  return { client, path: resolved, serverIds: servers.map((server) => server.id) }
}

function syncClaude(input: SyncForFormatInput): {
  target: McpSyncTarget
  issues: McpValidationIssue[]
} {
  const { plugin, servers, knownServerIds, workspaceRoot, write, context, client } = input
  const workspaceServers = servers.filter((server) => server.scope === 'workspace')
  const userServers = servers.filter((server) => server.scope === 'user')
  const issues = userServers.map((server): McpValidationIssue => ({
    level: server.required ? 'error' : 'warning',
    client,
    serverId: server.id,
    message: `Claude user-scoped MCP sync is not implemented yet for ${server.name}; use workspace scope or claude mcp add.`,
  }))
  const path = resolveMcpTargetPath(plugin.mcpConfig!, 'workspace', workspaceRoot, context.homeDir)
  if (!path) {
    return {
      target: { client, path: '', serverIds: workspaceServers.map((server) => server.id) },
      issues,
    }
  }
  if (write && (workspaceServers.length > 0 || knownServerIds.length > 0)) {
    mkdirSync(dirname(path), { recursive: true })
    let existing: Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      } catch {
        issues.push({
          level: 'error',
          client,
          message: `.mcp.json is not valid JSON. Fix it before syncing Claude MCPs.`,
        })
        return {
          target: { client, path, serverIds: workspaceServers.map((server) => server.id) },
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
    target: { client, path, serverIds: workspaceServers.map((server) => server.id) },
    issues,
  }
}

function replaceManagedBlock(previous: string, block: string): string {
  const pattern = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, 'm')
  const trimmed = previous.replace(pattern, '').trimEnd()
  if (!block) return trimmed ? `${trimmed}\n` : ''
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`
}

function removeCodexManagedServers(previous: string, serverIds: string[]): string {
  const ids = new Set(serverIds)
  if (ids.size === 0) return previous
  const pattern = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, 'm')
  const match = previous.match(pattern)
  if (!match) return previous

  const block = match[0].replace(/\n?$/, '')
  const lines = block.split(/\r?\n/)
  const inner = lines.slice(1, -1)
  const preamble: string[] = []
  const sections: Array<{ id: string, lines: string[] }> = []
  let current: { id: string, lines: string[] } | null = null

  for (const line of inner) {
    const section = line.match(/^\[mcp_servers\.([a-z0-9_-]+)\]$/)
    if (section) {
      current = { id: section[1]!, lines: [line] }
      sections.push(current)
      continue
    }
    if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }

  const remaining = sections.filter((section) => !ids.has(section.id))
  if (remaining.length === 0) return replaceManagedBlock(previous, '')

  while (preamble.length > 0 && preamble[preamble.length - 1] === '') preamble.pop()
  const nextBlock = [
    MANAGED_START,
    ...preamble,
    ...remaining.flatMap((section) => ['', ...section.lines]),
    MANAGED_END,
  ].join('\n')
  return replaceManagedBlock(previous, nextBlock)
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
    const headers = server.envVarNames?.length
      ? Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'))
      : server.headers
    if (headers && Object.keys(headers).length) lines.push(`http_headers = { ${Object.entries(headers).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`)
  }
  lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`)
  if (server.required && server.id !== MANAGED_SPRINTENGINE_MCP_SERVER_ID) lines.push('required = true')
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
    ...httpHeadersForClaude(server),
  }
}

function httpHeadersForClaude(server: McpServerConfig): { headers?: Record<string, string> } {
  const headers = { ...(server.headers ?? {}) }
  if (!headers.Authorization && server.envVarNames?.[0]) {
    headers.Authorization = `Bearer \${${server.envVarNames[0]}}`
  }
  return Object.keys(headers).length ? { headers } : {}
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
