import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

// Lazy electron so the module is importable from node-only test bundles.
function loadElectron(): typeof import('electron') {
  return require('electron')
}
import type {
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
// MCP server-config normalization lives in shared/mcp so node-free consumers
// (the marketplace registry validator) apply identical rules; re-exported here
// to keep this module's public surface stable for existing callers.
import { normalizeMcpClients, normalizeMcpServerConfig, normalizeServer } from '../shared/mcp/normalize-server'
import { pluginIdForCli } from './agent-launch-render'
import { commandOnPath } from './command-on-path'
import { getPluginById } from './plugin-registry-instance'
import { STUDIO_MCP_SERVER_ID } from '../shared/product-identity'

export { normalizeMcpClients, normalizeMcpServerConfig }

const MANAGED_START = '# >>> sprintengine mcp managed'
const MANAGED_END = '# <<< sprintengine mcp managed'

/**
 * The id the deleted in-tree Sprint Engine wrote its per-run HTTP server under.
 * Nothing serves it any more, so a workspace that ran a sprint keeps an entry
 * pointing at a dead hub and the CLI shows a failed server. The Studio sync
 * pass forgets it (`studio-mcp-sync.ts`) and the Claude settings writer keeps
 * it out of the enabled/disabled lists. A filter, not a migration: nothing is
 * carried forward.
 */
export const RETIRED_SPRINTENGINE_MCP_SERVER_ID = 'sprintengine-sprintengine'

export type PluginLookup = (id: string) => { manifest: PluginManifest } | undefined

export type McpConfigService = {
  previewSync(input: McpSyncInput): McpSyncPreview
  sync(input: McpSyncInput): McpSyncResult
}

export type McpConfigServiceOptions = {
  lookupPlugin?: PluginLookup
  homeDir?: () => string
  userDataDir?: () => string
}

export function createMcpConfigService(options: McpConfigServiceOptions = {}): McpConfigService {
  const lookupPlugin: PluginLookup = options.lookupPlugin ?? ((id) => getPluginById(id))
  const homeDir = options.homeDir ?? (() => homedir())
  const userDataDir = options.userDataDir ?? (() => defaultUserDataDir(homeDir))
  return {
    previewSync: (input) => syncMcpConfig({ ...input, write: false }, { lookupPlugin, homeDir, userDataDir }),
    sync: (input) => syncMcpConfig({ ...input, write: true }, { lookupPlugin, homeDir, userDataDir }),
  }
}

type SyncContext = {
  lookupPlugin: PluginLookup
  homeDir: () => string
  userDataDir: () => string
}

function syncMcpConfig(input: McpSyncInput, context: SyncContext): McpSyncResult {
  const settings = normalizeSettings(input.settings)
  const clients = normalizeMcpClients(input.clients)
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

  // Ids the caller has already dropped from settings and wants out of the
  // configs. They belong to every client's known list, because a forgotten
  // server no longer says which clients it was written for.
  const forgottenServerIds = (input.forgetServerIds ?? [])
    .map((id) => String(id ?? '').trim())
    .filter((id) => id !== '' && !(id in settings.servers))

  const targets: McpSyncTarget[] = []
  for (const client of clients) {
    const clientServers = activeServers.filter((server) => server.clients.includes(client))
    const knownClientServerIds = [
      ...Object.values(settings.servers)
        .filter((server) => server.clients.includes(client))
        .map((server) => server.id),
      ...forgottenServerIds,
    ]
    if (clientServers.length === 0 && knownClientServerIds.length === 0) continue

    const pluginId = pluginIdForCli(client)
    const plugin = context.lookupPlugin(pluginId)
    if (!plugin || !plugin.manifest.mcpConfig) {
      const hasRequired = clientServers.some((server) => server.required)
      issues.push({
        level: hasRequired ? 'error' : 'warning',
        client,
        message: hasRequired
          ? `Plugin "${pluginId}" has no MCP config writer; Studio-launched agents require an mcpConfig block for the app-owned gateway.`
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
          ? `Plugin "${pluginId}" does not support managed MCP servers; Studio-launched agents require MCP support via capabilities.mcpServers.`
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
      pruneUnlisted: input.pruneUnlistedServers === true,
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

function defaultUserDataDir(homeDir: () => string): string {
  try {
    const electron = loadElectron()
    const userData = electron.app?.getPath?.('userData')
    if (userData) return userData
  } catch {
    // Node-only tests do not provide Electron's app object.
  }
  return join(homeDir(), '.sprintengine')
}

function normalizeSettings(settings: McpSettings | undefined): McpSettings {
  if (!settings || typeof settings !== 'object') {
    return { syncEnabled: false, servers: {} }
  }
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

function validateServer(server: McpServerConfig): McpValidationIssue[] {
  const issues: McpValidationIssue[] = []
  if (server.transport === 'stdio') {
    const command = server.command?.trim()
    if (!command) {
      issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a command.` })
    } else if (!commandOnPath(command)) {
      issues.push({
        level: server.required ? 'error' : 'warning',
        serverId: server.id,
        message: `${server.name} command was not found: ${command}`,
      })
    }
  }
  if ((server.transport === 'http' || server.transport === 'sse') && !server.url?.trim()) {
    issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a URL.` })
  }
  for (const envVar of server.envVarNames ?? []) {
    if (!process.env[envVar]) {
      issues.push({
        level: server.required ? 'error' : 'warning',
        serverId: server.id,
        message: `${server.name} expects environment variable ${envVar}.`,
      })
    }
  }
  return issues
}

/**
 * The absolute path a plugin's declared MCP config template resolves to, or
 * null when the plugin declares none for that scope. The one place those
 * templates are substituted: the writers below and the read path
 * (src/main/mcp-config-readers/resolve-servers.ts) must agree byte for byte, or
 * the app would read a different file than it writes.
 */
export function resolveMcpConfigPath(
  spec: PluginMcpConfigSpec,
  scope: McpScope,
  workspaceRoot: string,
  homeDir: () => string,
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
  // Connector-scoped write: prune every server not in `servers` from the target
  // config so the worktree ends with exactly the connector set (see McpSyncInput).
  pruneUnlisted: boolean
  write: boolean
  context: SyncContext
}

function syncForFormat(input: SyncForFormatInput): {
  targets: McpSyncTarget[]
  issues: McpValidationIssue[]
} {
  const format = input.plugin.mcpConfig!.format
  switch (format) {
    case 'codex': {
      const result = syncCodex(input)
      return { targets: [result.target], issues: result.issues }
    }
    case 'claude-code': {
      const result = syncClaude(input)
      return { targets: [result.target], issues: result.issues }
    }
    case 'opencode': {
      const result = syncOpencode(input)
      return { targets: [result.target], issues: result.issues }
    }
    case 'generic': {
      const hasRequired = input.servers.some((server) => server.required)
      return {
        targets: [],
        issues: [
          {
            level: hasRequired ? 'error' : 'warning',
            client: input.client,
            message: hasRequired
              ? `MCP sync writer for format "${format}" is not implemented yet; Studio-launched agents require a workspace stdio MCP config writer for plugin "${input.plugin.id}".`
              : `MCP sync writer for format "${format}" is not implemented yet; declared in plugin "${input.plugin.id}".`,
          },
        ],
      }
    }
  }
}

function syncCodex(input: SyncForFormatInput): {
  target: McpSyncTarget
  issues: McpValidationIssue[]
} {
  const { plugin, servers, knownServerIds, pruneUnlisted, workspaceRoot, write, context, client } = input
  const scope: McpScope = servers.some((server) => server.scope === 'user') ? 'user' : 'workspace'
  const resolved = resolveMcpConfigPath(plugin.mcpConfig!, scope, workspaceRoot, context.homeDir)
  const serverIds = servers.map((server) => server.id)
  if (!resolved) {
    return { target: { client, path: '', serverIds }, issues: [] }
  }
  const target = { client, path: resolved, serverIds }
  if (write && (servers.length > 0 || knownServerIds.length > 0)) {
    const prepared = prepareWritableConfigFile(resolved, client)
    if (!prepared.ok) return { target, issues: [prepared.issue] }
    // Connector-scoped write: drop every [mcp_servers.*] table the repo committed
    // outside our managed block (renderCodexManagedBlock only rewrites the managed
    // block, which is the sole source of truth for the connector set). Keep none —
    // even a bare table sharing the connector id, to avoid a duplicate section.
    // Other codex config (model, profiles, …) is preserved.
    const base = pruneUnlisted
      ? removeCommittedCodexMcpServers(replaceManagedBlock(prepared.previous, ''))
      : prepared.previous
    writeFileSync(
      resolved,
      servers.length
        ? replaceManagedBlock(base, renderCodexManagedBlock(servers))
        : removeCodexManagedServers(base, knownServerIds),
      'utf8',
    )
  }
  return { target, issues: [] }
}

function syncClaude(input: SyncForFormatInput): {
  target: McpSyncTarget
  issues: McpValidationIssue[]
} {
  const { plugin, servers, knownServerIds, pruneUnlisted, workspaceRoot, write, context, client } = input
  const workspaceServers = servers.filter((server) => server.scope === 'workspace')
  const userServers = servers.filter((server) => server.scope === 'user')
  const issues = userServers.map((server): McpValidationIssue => ({
    level: server.required ? 'error' : 'warning',
    client,
    serverId: server.id,
    message: `Claude user-scoped MCP sync is not implemented yet for ${server.name}; use workspace scope or claude mcp add.`,
  }))
  const path = resolveMcpConfigPath(plugin.mcpConfig!, 'workspace', workspaceRoot, context.homeDir)
  if (!path) {
    return {
      target: { client, path: '', serverIds: workspaceServers.map((server) => server.id) },
      issues,
    }
  }
  if (write && (workspaceServers.length > 0 || knownServerIds.length > 0)) {
    const prepared = prepareWritableConfigFile(path, client)
    if (!prepared.ok) {
      return {
        target: { client, path, serverIds: workspaceServers.map((server) => server.id) },
        issues: [...issues, prepared.issue],
      }
    }
    let existing: Record<string, unknown> = {}
    if (prepared.existed) {
      try {
        existing = JSON.parse(prepared.previous) as Record<string, unknown>
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
    const currentServers =
      existing.mcpServers && typeof existing.mcpServers === 'object'
        ? (existing.mcpServers as Record<string, unknown>)
        : {}
    // Connector-scoped write starts empty so any server the repo committed into
    // the worktree .mcp.json is dropped, not merged; the normal path preserves
    // the user's other servers and only replaces the ones we manage.
    const nextServers: Record<string, unknown> = pruneUnlisted ? {} : { ...currentServers }
    if (!pruneUnlisted) {
      for (const serverId of knownServerIds) {
        delete nextServers[serverId]
      }
    }
    for (const server of workspaceServers) {
      nextServers[server.id] = toClaudeServer(server)
    }
    writeFileSync(path, `${JSON.stringify({ ...existing, mcpServers: nextServers }, null, 2)}\n`, 'utf8')
    if (plugin.binary === 'claude' && workspaceServers.some((server) => server.id === STUDIO_MCP_SERVER_ID)) {
      const approvalIssue = enableStudioMcpForClaudeWorkspace(
        workspaceRoot,
        client,
        path,
        nextServers[STUDIO_MCP_SERVER_ID],
      )
      if (approvalIssue) issues.push(approvalIssue)
    }
  }
  return {
    target: { client, path, serverIds: workspaceServers.map((server) => server.id) },
    issues,
  }
}

// Claude records project MCP approval separately from `.mcp.json`. The Studio
// gateway is app-owned, so add only that one id to the allow-list;
// custom MCPs retain Claude's normal consent flow and every unrelated setting
// is preserved. Z.AI and Kimi Claude use the same Claude binary/config shape.
//
// Claude's approval is keyed by server ID only, so approval must never be
// granted against content we did not just write: a repo-committed `.mcp.json`
// squatting on our id would otherwise run an arbitrary command with no consent
// prompt. Verify the on-disk entry byte-matches the managed config at grant
// time; the sync path rewrites the entry on every launch, so drift is healed
// and re-verified per launch (installer command-shape rule, not id-trust).
function enableStudioMcpForClaudeWorkspace(
  workspaceRoot: string,
  client: McpClientTarget,
  mcpJsonPath: string,
  expectedServer: unknown,
): McpValidationIssue | null {
  try {
    const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as Record<string, unknown>
    const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>
    const onDisk = servers[STUDIO_MCP_SERVER_ID]
    if (JSON.stringify(onDisk) !== JSON.stringify(expectedServer)) {
      return {
        level: 'error',
        client,
        serverId: STUDIO_MCP_SERVER_ID,
        message: `${mcpJsonPath} does not contain the managed Studio MCP entry that was just written; refusing to pre-approve the server id.`,
      }
    }
  } catch (error) {
    return {
      level: 'error',
      client,
      serverId: STUDIO_MCP_SERVER_ID,
      message: `Could not verify ${mcpJsonPath} before approving the Studio MCP server: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const settingsPath = join(workspaceRoot, '.claude', 'settings.local.json')
  const prepared = prepareWritableConfigFile(settingsPath, client)
  if (!prepared.ok) return prepared.issue
  let existing: Record<string, unknown> = {}
  if (prepared.existed && prepared.previous.trim()) {
    try {
      existing = JSON.parse(prepared.previous) as Record<string, unknown>
    } catch {
      return {
        level: 'error',
        client,
        message: `${settingsPath} is not valid JSON. Fix it before syncing the required Studio MCP server.`,
      }
    }
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const withoutManagedIds = (values: string[]): string[] =>
    values.filter((id) => id !== STUDIO_MCP_SERVER_ID && id !== RETIRED_SPRINTENGINE_MCP_SERVER_ID)
  const enabled = [...withoutManagedIds(strings(existing.enabledMcpjsonServers)), STUDIO_MCP_SERVER_ID]
  const disabled = withoutManagedIds(strings(existing.disabledMcpjsonServers))
  const next: Record<string, unknown> = {
    ...existing,
    enabledMcpjsonServers: enabled,
  }
  if (disabled.length > 0) next.disabledMcpjsonServers = disabled
  else delete next.disabledMcpjsonServers
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return null
}

function syncOpencode(input: SyncForFormatInput): {
  target: McpSyncTarget
  issues: McpValidationIssue[]
} {
  const { plugin, servers, knownServerIds, pruneUnlisted, workspaceRoot, write, context, client } = input
  const issues: McpValidationIssue[] = []
  // OpenCode's `mcp` schema expresses local (stdio) and remote (HTTP) servers
  // only. Surface anything it cannot represent instead of writing a fake entry.
  const writableServers: McpServerConfig[] = []
  for (const server of servers) {
    if (server.transport === 'sse') {
      issues.push({
        level: server.required ? 'error' : 'warning',
        client,
        serverId: server.id,
        message: `OpenCode MCP config supports local (stdio) and remote (HTTP) servers only; SSE server ${server.name} cannot be synced. Use an HTTP endpoint instead.`,
      })
      continue
    }
    writableServers.push(server)
  }

  const serverIds = writableServers.map((server) => server.id)
  const scope: McpScope = writableServers.some((server) => server.scope === 'user') ? 'user' : 'workspace'
  const path = resolveMcpConfigPath(plugin.mcpConfig!, scope, workspaceRoot, context.homeDir)
  if (!path) return { target: { client, path: '', serverIds }, issues }
  if (issues.some((issue) => issue.level === 'error')) {
    return { target: { client, path, serverIds }, issues }
  }

  if (write && (writableServers.length > 0 || knownServerIds.length > 0)) {
    const prepared = prepareWritableConfigFile(path, client)
    if (!prepared.ok) {
      return { target: { client, path, serverIds }, issues: [...issues, prepared.issue] }
    }
    // Nothing to add and no file to prune from: do not create an empty config.
    if (!prepared.existed && writableServers.length === 0) {
      return { target: { client, path, serverIds }, issues }
    }
    let existing: Record<string, unknown> = {}
    if (prepared.existed && prepared.previous.trim()) {
      try {
        existing = JSON.parse(prepared.previous) as Record<string, unknown>
      } catch {
        issues.push({
          level: 'error',
          client,
          message: `opencode.json is not valid JSON. Fix it before syncing OpenCode MCPs.`,
        })
        return { target: { client, path, serverIds }, issues }
      }
    }
    const currentServers =
      existing.mcp && typeof existing.mcp === 'object' && !Array.isArray(existing.mcp)
        ? (existing.mcp as Record<string, unknown>)
        : {}
    // Connector-scoped write drops any repo-committed server (start empty); the
    // normal path keeps the user's servers and only replaces the managed ones.
    const nextServers: Record<string, unknown> = pruneUnlisted ? {} : { ...currentServers }
    if (!pruneUnlisted) {
      for (const serverId of knownServerIds) {
        delete nextServers[serverId]
      }
    }
    for (const server of writableServers) {
      nextServers[server.id] = toOpencodeServer(server)
    }
    const next: Record<string, unknown> = { ...existing }
    if (Object.keys(nextServers).length) {
      next.mcp = nextServers
    } else {
      delete next.mcp
    }
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }
  return { target: { client, path, serverIds }, issues }
}

function toOpencodeServer(server: McpServerConfig): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const entry: Record<string, unknown> = {
      type: 'local',
      command: opencodeLocalCommand(server),
    }
    if (server.env && Object.keys(server.env).length) entry.environment = server.env
    return entry
  }
  const entry: Record<string, unknown> = { type: 'remote', url: server.url ?? '' }
  const headers = opencodeRemoteHeaders(server)
  if (Object.keys(headers).length) entry.headers = headers
  return entry
}

function opencodeLocalCommand(server: McpServerConfig): string[] {
  const command = server.command ?? ''
  const args = server.args ?? []
  if (process.platform === 'win32' && command === 'npx') {
    return ['cmd', '/c', 'npx', ...args]
  }
  return [command, ...args]
}

function opencodeRemoteHeaders(server: McpServerConfig): Record<string, string> {
  // OpenCode interpolates `{env:VAR}` in string fields; an env-backed bearer
  // token replaces any caller-supplied Authorization header so the literal
  // secret is never written to disk.
  const headers: Record<string, string> = server.envVarNames?.length
    ? Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'))
    : { ...server.headers }
  if (server.envVarNames?.[0]) {
    headers.Authorization = `Bearer {env:${server.envVarNames[0]}}`
  }
  return headers
}

type WritableConfigFileResult =
  { ok: true; previous: string; existed: boolean } | { ok: false; issue: McpValidationIssue }

function prepareWritableConfigFile(path: string, client: McpClientTarget): WritableConfigFileResult {
  const directory = dirname(path)
  try {
    if (existsSync(directory) && !statSync(directory).isDirectory()) {
      return {
        ok: false,
        issue: {
          level: 'error',
          client,
          message: `Cannot sync MCP config for ${client}: expected ${directory} to be a directory, but it is a file. Rename or remove that file, or disable MCP sync for this CLI.`,
        },
      }
    }
    mkdirSync(directory, { recursive: true })
    if (!existsSync(path)) return { ok: true, previous: '', existed: false }
    if (statSync(path).isDirectory()) {
      return {
        ok: false,
        issue: {
          level: 'error',
          client,
          message: `Cannot sync MCP config for ${client}: expected ${path} to be a config file, but it is a directory. Rename or remove that directory, or disable MCP sync for this CLI.`,
        },
      }
    }
    return { ok: true, previous: readFileSync(path, 'utf8'), existed: true }
  } catch (error) {
    return {
      ok: false,
      issue: {
        level: 'error',
        client,
        message: `Cannot sync MCP config for ${client} at ${path}: ${error instanceof Error ? error.message : 'Unknown filesystem error.'}`,
      },
    }
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
  const sections: Array<{ id: string; lines: string[] }> = []
  let current: { id: string; lines: string[] } | null = null

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

// Strip every top-level `[mcp_servers.<id>]` table (and its sub-tables) from a
// codex config, leaving all other config intact. Used only on the connector-
// scoped write, after the managed block has been removed, so a server the base
// repo committed into the worktree config.toml cannot survive into a connector
// chat; the managed block re-added afterwards is the sole source of the connector.
function removeCommittedCodexMcpServers(text: string): string {
  const out: string[] = []
  let dropping = false
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/)
    if (header) {
      dropping =
        header[1]!
          .trim()
          .replace(/^["']|["']$/g, '')
          .split('.')[0] === 'mcp_servers'
    }
    if (!dropping) out.push(line)
  }
  return out.join('\n')
}

function renderCodexManagedBlock(servers: McpServerConfig[]): string {
  return [
    MANAGED_START,
    '# This section is generated by SprintEngine Settings. Edit MCPs in SprintEngine or remove this block.',
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
    if (server.env)
      lines.push(
        `env = { ${Object.entries(server.env)
          .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
          .join(', ')} }`,
      )
  } else {
    lines.push(`url = ${tomlString(server.url ?? '')}`)
    if (server.envVarNames?.length) lines.push(`bearer_token_env_var = ${tomlString(server.envVarNames[0])}`)
    const headers = server.envVarNames?.length
      ? Object.fromEntries(
          Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'),
        )
      : server.headers
    if (headers && Object.keys(headers).length)
      lines.push(
        `http_headers = { ${Object.entries(headers)
          .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
          .join(', ')} }`,
      )
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
      args:
        process.platform === 'win32' && server.command === 'npx'
          ? ['/c', 'npx', ...(server.args ?? [])]
          : (server.args ?? []),
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
  const headers = { ...server.headers }
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
