import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, relative } from 'path'

import type {
  AgentConfigAdoptInput,
  AgentConfigAdoptResult,
  AgentConfigAdoptedMcpServer,
  AgentConfigAdoptedSkill,
  AgentConfigDetectedMcpServer,
  AgentConfigDetectedSkill,
  AgentConfigDetectInput,
  AgentConfigDetectResult,
  AgentConfigImportSource,
  BuiltinSkill,
  BuiltinSkillInstallResult,
  McpClientTarget,
  McpRiskLevel,
  McpServerConfig,
  McpSettings,
  McpTransport,
} from '../shared/electron-api'
import {
  normalizeMcpClients,
  normalizeMcpServerConfig,
  type McpConfigService,
} from './mcp-config-service'

type BuiltinSkillInstaller = {
  list(): Promise<BuiltinSkill[]>
  install(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillInstallResult>
}

export type AgentConfigImportService = {
  detect(input?: AgentConfigDetectInput): Promise<AgentConfigDetectResult>
  adopt(input: AgentConfigAdoptInput): Promise<AgentConfigAdoptResult>
}

export type AgentConfigImportServiceOptions = {
  mcpConfigService: Pick<McpConfigService, 'sync'>
  builtinSkillManager: BuiltinSkillInstaller
  homeDir?: () => string
}

type SourceConfig = {
  source: AgentConfigImportSource
  client: McpClientTarget
  mcpConfigPaths: string[]
  skillsDir: string
}

type RawMcpServer = {
  id: string
  name?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled?: boolean
}

type DiscoveredMcpServer = {
  entry: AgentConfigDetectedMcpServer
  server: McpServerConfig
}

type DiscoveredSkill = {
  entry: AgentConfigDetectedSkill
  skillId: string
}

type Discovery = {
  mcpServers: DiscoveredMcpServer[]
  skills: DiscoveredSkill[]
  warnings: string[]
}

export function createAgentConfigImportService(
  options: AgentConfigImportServiceOptions,
): AgentConfigImportService {
  return {
    detect: async (input) => {
      const discovery = await discoverExistingAgentConfig(input, options)
      return {
        ok: true,
        mcpServers: discovery.mcpServers.map((server) => server.entry),
        skills: discovery.skills.map((skill) => skill.entry),
        warnings: discovery.warnings,
      }
    },
    adopt: (input) => adoptAgentConfig(input, options),
  }
}

async function adoptAgentConfig(
  input: AgentConfigAdoptInput,
  options: AgentConfigImportServiceOptions,
): Promise<AgentConfigAdoptResult> {
  const workspaceRoot = typeof input?.workspaceRoot === 'string' ? input.workspaceRoot.trim() : ''
  if (!workspaceRoot || !isDirectory(workspaceRoot)) {
    return { ok: false, message: 'Workspace root does not exist.' }
  }

  const discovery = await discoverExistingAgentConfig(undefined, options)
  const warnings = [...discovery.warnings]
  const mcpByKey = new Map(discovery.mcpServers.map((server) => [server.entry.key, server]))
  const skillByKey = new Map(discovery.skills.map((skill) => [skill.entry.key, skill]))
  const selectedMcpKeys = normalizeStringSet(input?.mcpServerKeys)
  const selectedSkillKeys = normalizeStringSet(input?.skillKeys)

  for (const key of selectedMcpKeys) {
    if (!mcpByKey.has(key)) {
      return { ok: false, message: `Selected MCP server was not found: ${key}`, warnings }
    }
  }
  for (const key of selectedSkillKeys) {
    const skill = skillByKey.get(key)
    if (!skill) return { ok: false, message: `Selected skill was not found: ${key}`, warnings }
    if (!skill.entry.adoptable) {
      return {
        ok: false,
        message: `Cannot adopt custom skill "${skill.skillId}" through the built-in skill sync path.`,
        warnings,
      }
    }
  }

  const adoptedMcpServers: AgentConfigAdoptedMcpServer[] = []
  const selectedMcpServers = Array.from(selectedMcpKeys, (key) => mcpByKey.get(key)!)
  if (selectedMcpServers.length > 0) {
    const settings = buildAdoptedMcpSettings(selectedMcpServers, warnings)
    const clients = normalizeMcpClients(Object.values(settings.servers).flatMap((server) => server.clients))
    const syncResult = options.mcpConfigService.sync({ workspaceRoot, settings, clients })
    if (!syncResult.ok) {
      return {
        ok: false,
        message: syncResult.message,
        adoptedMcpServers,
        adoptedSkills: [],
        warnings: [...warnings, ...(syncResult.issues ?? []).map((issue) => issue.message)],
      }
    }
    warnings.push(...syncResult.issues.filter((issue) => issue.level === 'warning').map((issue) => issue.message))
    for (const server of Object.values(settings.servers)) {
      adoptedMcpServers.push({ id: server.id, clients: server.clients })
    }
  }

  const adoptedSkills: AgentConfigAdoptedSkill[] = []
  const selectedSkillIds = Array.from(new Set(Array.from(selectedSkillKeys, (key) => skillByKey.get(key)!.skillId)))
  for (const skillId of selectedSkillIds) {
    const result = await options.builtinSkillManager.install(workspaceRoot, skillId)
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        adoptedMcpServers,
        adoptedSkills,
        warnings,
      }
    }
    adoptedSkills.push({ id: result.skill.id, status: result.status })
  }

  return { ok: true, adoptedMcpServers, adoptedSkills, warnings }
}

function buildAdoptedMcpSettings(
  servers: DiscoveredMcpServer[],
  warnings: string[],
): McpSettings {
  const byId = new Map<string, McpServerConfig>()
  for (const discovered of servers) {
    const existing = byId.get(discovered.server.id)
    if (!existing) {
      byId.set(discovered.server.id, { ...discovered.server, clients: [...discovered.server.clients] })
      continue
    }
    existing.clients = normalizeMcpClients([...existing.clients, ...discovered.server.clients])
    if (!sameMcpServerTarget(existing, discovered.server)) {
      warnings.push(`Duplicate MCP server "${existing.id}" was found in multiple agent configs; using the first config and merging clients.`)
    }
  }
  return {
    syncEnabled: true,
    servers: Object.fromEntries(Array.from(byId.values()).map((server) => [server.id, server])),
  }
}

function sameMcpServerTarget(a: McpServerConfig, b: McpServerConfig): boolean {
  return a.transport === b.transport
    && (a.command ?? '') === (b.command ?? '')
    && (a.url ?? '') === (b.url ?? '')
    && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
}

async function discoverExistingAgentConfig(
  input: AgentConfigDetectInput | undefined,
  options: AgentConfigImportServiceOptions,
): Promise<Discovery> {
  const home = options.homeDir?.() ?? homedir()
  const selectedSources = new Set(normalizeSources(input?.sources))
  const builtInSkills = await options.builtinSkillManager.list()
  const builtInSkillById = new Map(builtInSkills.map((skill) => [skill.id, skill]))
  const warnings: string[] = []
  const mcpServers: DiscoveredMcpServer[] = []
  const skills: DiscoveredSkill[] = []

  for (const source of sourceConfigs(home)) {
    if (!selectedSources.has(source.source)) continue
    for (const configPath of source.mcpConfigPaths) {
      mcpServers.push(...readMcpConfigPath(source, configPath, home, warnings))
    }
    skills.push(...readSkillDirectory(source, home, builtInSkillById, warnings))
  }

  return { mcpServers: dedupeMcpServers(mcpServers, warnings), skills, warnings }
}

function sourceConfigs(home: string): SourceConfig[] {
  return [
    {
      source: 'codex',
      client: 'codex',
      mcpConfigPaths: [join(home, '.codex', 'config.toml')],
      skillsDir: join(home, '.codex', 'skills'),
    },
    {
      source: 'claude-code',
      client: 'claude-code',
      mcpConfigPaths: [
        join(home, '.claude', '.mcp.json'),
        join(home, '.claude', 'mcp.json'),
        join(home, '.claude.json'),
      ],
      skillsDir: join(home, '.claude', 'skills'),
    },
  ]
}

function normalizeSources(value: AgentConfigImportSource[] | undefined): AgentConfigImportSource[] {
  const sources = (value ?? ['codex', 'claude-code']).filter(
    (source): source is AgentConfigImportSource => source === 'codex' || source === 'claude-code',
  )
  return Array.from(new Set(sources))
}

function dedupeMcpServers(
  servers: DiscoveredMcpServer[],
  warnings: string[],
): DiscoveredMcpServer[] {
  const byKey = new Map<string, DiscoveredMcpServer>()
  for (const server of servers) {
    if (byKey.has(server.entry.key)) {
      warnings.push(`Duplicate MCP server "${server.entry.id}" was found in ${server.entry.source}; using the first detected config.`)
      continue
    }
    byKey.set(server.entry.key, server)
  }
  return Array.from(byKey.values())
}

function readMcpConfigPath(
  source: SourceConfig,
  configPath: string,
  home: string,
  warnings: string[],
): DiscoveredMcpServer[] {
  if (!existsSync(configPath)) return []
  const sourceLabel = homeRelativeLabel(home, configPath)
  if (!isFile(configPath)) {
    warnings.push(`${sourceLabel} exists but is not a file; skipping MCP import from it.`)
    return []
  }

  try {
    const raw = readFileSync(configPath, 'utf8')
    const servers = source.source === 'codex'
      ? readCodexMcpServers(raw)
      : readClaudeMcpServers(raw)
    return servers
      .map((server) => normalizeDetectedServer(source, sourceLabel, server))
      .filter((server): server is DiscoveredMcpServer => Boolean(server))
  } catch (error) {
    warnings.push(`${sourceLabel} could not be read as ${source.source} MCP config: ${errorMessage(error)}`)
    return []
  }
}

function normalizeDetectedServer(
  source: SourceConfig,
  sourceLabel: string,
  raw: RawMcpServer,
): DiscoveredMcpServer | null {
  const server = normalizeMcpServerConfig({
    id: raw.id,
    name: raw.name ?? raw.id,
    transport: raw.transport,
    command: raw.command,
    args: raw.args,
    url: raw.url,
    env: raw.env,
    envVarNames: raw.envVarNames,
    headers: raw.headers,
    enabled: raw.enabled !== false,
    clients: [source.client],
    scope: 'workspace',
    source: 'custom',
    riskLevel: riskLevelForRawServer(raw),
  })
  if (!server) return null
  return {
    server,
    entry: {
      key: mcpServerKey(source.source, server.id),
      id: server.id,
      name: server.name,
      source: source.source,
      sourceLabel,
      transport: server.transport,
      enabled: server.enabled,
      envVarNames: server.envVarNames ?? [],
      hasSecretValues: hasStringRecord(server.env) || hasStringRecord(server.headers),
    },
  }
}

function readSkillDirectory(
  source: SourceConfig,
  home: string,
  builtInSkillById: Map<string, BuiltinSkill>,
  warnings: string[],
): DiscoveredSkill[] {
  if (!existsSync(source.skillsDir)) return []
  const sourceLabel = homeRelativeLabel(home, source.skillsDir)
  if (!isDirectory(source.skillsDir)) {
    warnings.push(`${sourceLabel} exists but is not a directory; skipping skill import from it.`)
    return []
  }

  try {
    return readdirSync(source.skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .map((skillId): DiscoveredSkill => {
        const builtInSkill = builtInSkillById.get(skillId)
        return {
          skillId,
          entry: {
            key: skillKey(source.source, skillId),
            id: skillId,
            name: builtInSkill?.name ?? skillId,
            source: source.source,
            sourceLabel: `${sourceLabel}/${skillId}`,
            adoptable: Boolean(builtInSkill),
          },
        }
      })
  } catch (error) {
    warnings.push(`${sourceLabel} could not be listed: ${errorMessage(error)}`)
    return []
  }
}

function readClaudeMcpServers(raw: string): RawMcpServer[] {
  const parsed = JSON.parse(raw) as unknown
  const root = asRecord(parsed)
  const mcpServers = asRecord(root?.mcpServers)
  if (!mcpServers) return []

  const servers: RawMcpServer[] = []
  for (const [id, value] of Object.entries(mcpServers)) {
    const config = asRecord(value)
    if (!config) continue
    const type = typeof config.type === 'string' ? config.type.trim() : ''
    const url = stringValue(config.url)
    const command = stringValue(config.command)
    const transport: McpTransport = type === 'http' || type === 'sse'
      ? type
      : url ? 'http' : 'stdio'
    if (transport === 'stdio' && !command) continue
    if (transport !== 'stdio' && !url) continue
    servers.push({
      id,
      name: id,
      transport,
      command,
      args: stringArray(config.args),
      url,
      env: stringRecord(config.env),
      headers: stringRecord(config.headers),
      enabled: config.enabled === false ? false : true,
    })
  }
  return servers
}

function readCodexMcpServers(raw: string): RawMcpServer[] {
  const sections = parseCodexMcpToml(raw)
  const servers: RawMcpServer[] = []
  for (const [id, config] of Object.entries(sections)) {
    const url = stringValue(config.url)
    const command = stringValue(config.command)
    const transport: McpTransport = url ? 'http' : 'stdio'
    if (transport === 'stdio' && !command) continue
    const bearer = stringValue(config.bearer_token_env_var)
    const envVarNames = [
      ...stringArray(config.env_vars),
      ...(bearer ? [bearer] : []),
    ]
    servers.push({
      id,
      name: id,
      transport,
      command,
      args: stringArray(config.args),
      url,
      env: stringRecord(config.env),
      headers: stringRecord(config.http_headers),
      envVarNames,
      enabled: config.enabled === false ? false : true,
    })
  }
  return servers
}

function parseCodexMcpToml(raw: string): Record<string, Record<string, unknown>> {
  const sections: Record<string, Record<string, unknown>> = {}
  let current: Record<string, unknown> | null = null
  const lines = raw.split(/\r?\n/)

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = stripTomlComment(lines[lineIndex]!).trim()
    if (!line) continue

    const section = line.match(/^\[\s*mcp_servers\s*\.\s*(.+?)\s*\]$/)
    if (section) {
      const id = parseTomlKey(section[1]!)
      current = id ? sections[id] ?? (sections[id] = {}) : null
      continue
    }
    if (!current) continue

    const separator = findTopLevelEquals(line)
    if (separator <= 0) continue
    const key = parseTomlKey(line.slice(0, separator).trim())
    if (!key) continue
    let value = line.slice(separator + 1).trim()
    while (value && !isCompleteTomlValue(value)) {
      lineIndex += 1
      if (lineIndex >= lines.length) {
        throw new Error(`Unterminated TOML value for key "${key}".`)
      }
      const continuation = stripTomlComment(lines[lineIndex]!).trim()
      if (continuation) value = `${value} ${continuation}`
    }
    current[key] = parseTomlValue(value)
  }

  return sections
}

function parseTomlValue(value: string): unknown {
  if (!value) return ''
  if (!isCompleteTomlValue(value)) throw new Error('Unbalanced TOML value.')
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('"') || value.startsWith("'")) return parseTomlString(value)
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error('Invalid TOML array value.')
    return splitTopLevel(value.slice(1, -1)).map((part) => parseTomlValue(part.trim()))
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new Error('Invalid TOML inline table value.')
    const record: Record<string, unknown> = {}
    for (const part of splitTopLevel(value.slice(1, -1))) {
      const separator = findTopLevelEquals(part)
      if (separator <= 0) continue
      const key = parseTomlKey(part.slice(0, separator).trim())
      if (!key) continue
      record[key] = parseTomlValue(part.slice(separator + 1).trim())
    }
    return record
  }
  return value
}

function isCompleteTomlValue(value: string): boolean {
  let quote: '"' | "'" | null = null
  let escaped = false
  let bracketDepth = 0
  let braceDepth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (char === '"' || char === "'")) {
      quote = quote === char ? null : quote ?? char
    } else if (!quote) {
      if (char === '[') bracketDepth += 1
      if (char === ']') bracketDepth -= 1
      if (char === '{') braceDepth += 1
      if (char === '}') braceDepth -= 1
    }
    escaped = false
  }
  return quote === null && bracketDepth === 0 && braceDepth === 0
}

function parseTomlKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return parseTomlString(trimmed)
  return trimmed
}

function parseTomlString(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, trimmed.endsWith('"') ? -1 : undefined)
    }
  }
  if (trimmed.startsWith("'")) return trimmed.slice(1, trimmed.endsWith("'") ? -1 : undefined)
  return trimmed
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (char === '"' || char === "'")) {
      quote = quote === char ? null : quote ?? char
    }
    if (!quote && char === '#') return line.slice(0, index)
    escaped = false
  }
  return line
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  let bracketDepth = 0
  let braceDepth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (char === '"' || char === "'")) {
      quote = quote === char ? null : quote ?? char
    } else if (!quote) {
      if (char === '[') bracketDepth += 1
      if (char === ']') bracketDepth -= 1
      if (char === '{') braceDepth += 1
      if (char === '}') braceDepth -= 1
      if (char === ',' && bracketDepth === 0 && braceDepth === 0) {
        parts.push(value.slice(start, index))
        start = index + 1
      }
    }
    escaped = false
  }
  parts.push(value.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

function findTopLevelEquals(value: string): number {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (!escaped && (char === '"' || char === "'")) {
      quote = quote === char ? null : quote ?? char
    } else if (!quote && char === '=') {
      return index
    }
    escaped = false
  }
  return -1
}

function riskLevelForRawServer(server: RawMcpServer): McpRiskLevel {
  if (hasStringRecord(server.env) || hasStringRecord(server.headers) || (server.envVarNames?.length ?? 0) > 0) {
    return 'secrets'
  }
  if (server.transport === 'http' || server.transport === 'sse') return 'network'
  if (server.command) return 'local-command'
  return 'low'
}

function hasStringRecord(value: Record<string, string> | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[0].trim()))
    .map(([key, item]) => [key.trim(), item] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeStringSet(value: string[] | undefined): Set<string> {
  return new Set((value ?? []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))
}

function mcpServerKey(source: AgentConfigImportSource, id: string): string {
  return `mcp:${source}:${id}`
}

function skillKey(source: AgentConfigImportSource, id: string): string {
  return `skill:${source}:${id}`
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function homeRelativeLabel(home: string, path: string): string {
  const rel = relative(home, path).replace(/\\/g, '/')
  return rel && !rel.startsWith('..') ? `~/${rel}` : path
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.'
}
