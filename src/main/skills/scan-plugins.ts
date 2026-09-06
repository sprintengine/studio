// The plugin scan rule: a repository tree becomes a list of plugins and the
// MCP servers they declare (backlog/2026-09-05-plugin-sources.md).
//
// A plugin is Claude Code's bundle shape — `.claude-plugin/plugin.json` over
// `skills/`, `commands/`, `agents/`, `hooks/hooks.json` and `.mcp.json`. A
// repository with a `.claude-plugin/marketplace.json` is a *marketplace*: its
// `plugins[]` list is the authority on what it holds, and an entry may point
// at a directory in this tree or at another repository (a *linked* plugin,
// read only when opened).
//
// The tree listing decides structure — which directories are plugins, which
// files are commands — and a handful of small files are read for the rest: the
// marketplace manifest, each plugin's manifest, its `.mcp.json` and its
// `hooks/hooks.json`. Those reads go through one injected reader, so the unit
// suite runs against recorded bytes with no network at all.

import {
  emptyPluginComponents,
  type ScannedMcpServer,
  type ScannedPlugin,
  type ScannedPluginComponents,
  type ScannedPluginHook,
  type ScannedPluginOrigin,
  type ScannedSkill,
  type SourceShape,
} from '../../shared/skills'
import type { SkillTreeEntry } from './scan'

export const CLAUDE_PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json'
export const CLAUDE_MARKETPLACE_MANIFEST_PATH = '.claude-plugin/marketplace.json'
const MCP_CONFIG_FILE = '.mcp.json'
const HOOKS_FILE = 'hooks/hooks.json'
const MCP_REGISTRY_MANIFEST = 'server.json'

/** How many in-tree plugins get their manifests read; beyond it they list by directory name. */
export const MAX_SCANNED_PLUGINS = 300
const READ_CONCURRENCY = 8

/** Reads one repo-relative file at the scanned commit; null when it is missing or unreadable. */
export type PluginFileReader = (path: string) => Promise<string | null>

export type PluginTreeScanInput = {
  entries: readonly SkillTreeEntry[]
  /** The skill scan of the same tree, so a plugin's skills are the same objects. */
  skills: readonly ScannedSkill[]
  marketplaceManifest: string | null
  readFile: PluginFileReader
}

export type PluginTreeScan = {
  shape: SourceShape
  marketplaceName: string
  plugins: ScannedPlugin[]
  /** Every server the source declares — through its plugins or at its root. */
  mcpServers: ScannedMcpServer[]
}

export async function scanPluginTree(input: PluginTreeScanInput): Promise<PluginTreeScan> {
  const blobs = new Set(
    input.entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path)
  )
  const pluginDirs = findPluginDirs(blobs)
  const marketplace = parseMarketplaceManifest(input.marketplaceManifest)

  // In-tree plugins: those the marketplace lists first, in its order, then any
  // manifest directory the marketplace forgot — a plugin that exists is a
  // plugin, whether or not it was enumerated.
  const plans: PluginPlan[] = []
  const claimedDirs = new Set<string>()
  if (marketplace) {
    for (const entry of marketplace.plugins) {
      if (entry.source.kind === 'in-tree') {
        claimedDirs.add(entry.source.path)
        plans.push({ entry, dir: entry.source.path, listedSkills: entry.skills })
      } else {
        plans.push({ entry, dir: null, listedSkills: entry.skills })
      }
    }
  }
  for (const dir of pluginDirs) {
    if (claimedDirs.has(dir)) continue
    plans.push({ entry: null, dir, listedSkills: [] })
  }

  const plugins: ScannedPlugin[] = new Array(plans.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, plans.length) }, async () => {
    while (cursor < plans.length) {
      const index = cursor
      cursor += 1
      plugins[index] = await realisePlan(plans[index], index, input, blobs)
    }
  })
  await Promise.all(workers)

  const declared = plugins.flatMap((plugin) => plugin.components.mcpServers)
  // A root `.mcp.json` or MCP-registry `server.json` outside any plugin: the
  // repository *is* a server (or ships one) without being a plugin.
  const rootIsPlugin = pluginDirs.includes('')
  const rootServers = rootIsPlugin ? [] : await readRootServers(blobs, input.readFile)
  const mcpServers = dedupeServers([...declared, ...rootServers])

  return {
    shape: deriveShape({
      marketplace: marketplace !== null,
      plugins: plugins.length,
      skills: input.skills.length,
      servers: mcpServers.length,
    }),
    marketplaceName: marketplace?.name ?? '',
    plugins,
    mcpServers,
  }
}

/**
 * The components of one plugin directory in a tree — the read a linked plugin
 * gets when it is opened and its own repository has been listed.
 */
export async function readPluginComponents(options: {
  dir: string
  entries: readonly SkillTreeEntry[]
  skills: readonly ScannedSkill[]
  readFile: PluginFileReader
  /** Skill paths the marketplace entry named, relative to `dir`. */
  listedSkills?: readonly string[]
}): Promise<{ manifest: PluginManifest | null; components: ScannedPluginComponents }> {
  const blobs = new Set(
    options.entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path)
  )
  return readComponents(options.dir, blobs, options.skills, options.readFile, options.listedSkills ?? [], null)
}

// ── Plans ───────────────────────────────────────────────────────────────────

type PluginPlan = {
  entry: MarketplaceEntry | null
  /** The in-tree directory, or null for a linked entry. */
  dir: string | null
  listedSkills: readonly string[]
}

async function realisePlan(
  plan: PluginPlan,
  index: number,
  input: PluginTreeScanInput,
  blobs: ReadonlySet<string>
): Promise<ScannedPlugin> {
  const entry = plan.entry
  if (plan.dir === null && entry && entry.source.kind === 'linked') {
    // Not read now: its bytes live in another repository. The entry's own
    // words are all that is known until it is opened.
    return {
      id: entry.name,
      name: entry.displayName || entry.name,
      description: entry.description,
      version: entry.version,
      category: entry.category,
      author: entry.author,
      homepage: entry.homepage,
      origin: entry.source,
      componentsKnown: false,
      components: emptyPluginComponents(),
    }
  }
  const dir = plan.dir ?? ''
  const overBudget = index >= MAX_SCANNED_PLUGINS
  const { manifest, components } = overBudget
    ? { manifest: null, components: emptyPluginComponents() }
    : await readComponents(dir, blobs, input.skills, input.readFile, plan.listedSkills, entry?.name ?? null)
  const dirName = dir === '' ? '' : dir.slice(dir.lastIndexOf('/') + 1)
  const id = entry?.name || manifest?.name || dirName || 'plugin'
  return {
    id,
    name: entry?.displayName || manifest?.name || entry?.name || dirName || 'plugin',
    description: entry?.description || manifest?.description || '',
    version: manifest?.version || entry?.version || '',
    category: entry?.category || '',
    author: entry?.author || manifest?.author || '',
    homepage: entry?.homepage || manifest?.homepage || '',
    origin: { kind: 'in-tree', path: dir },
    componentsKnown: !overBudget,
    components: { ...components, mcpServers: components.mcpServers.map((server) => ({ ...server, declaredBy: id })) },
  }
}

// ── Components ──────────────────────────────────────────────────────────────

export type PluginManifest = {
  name: string
  description: string
  version: string
  author: string
  homepage: string
}

async function readComponents(
  dir: string,
  blobs: ReadonlySet<string>,
  skills: readonly ScannedSkill[],
  readFile: PluginFileReader,
  listedSkills: readonly string[],
  declaredBy: string | null
): Promise<{ manifest: PluginManifest | null; components: ScannedPluginComponents }> {
  const under = (relative: string): string => (dir === '' ? relative : `${dir}/${relative}`)
  const manifestPath = under(CLAUDE_PLUGIN_MANIFEST_PATH)
  const rawManifest = blobs.has(manifestPath) ? await readFile(manifestPath) : null
  const parsedManifest = parsePluginManifest(rawManifest)

  // Skills: the marketplace entry's list when it has one, else `skills/*`.
  // Either way the skill objects are the scan's own, so a plugin's skill and
  // the same skill in the Skills list are one thing.
  const byId = new Map(skills.map((skill) => [skill.id, skill]))
  const pluginSkills: ScannedSkill[] = []
  const missingSkills: string[] = []
  if (listedSkills.length > 0) {
    for (const listed of listedSkills) {
      const path = normalizeRelative(listed)
      const skill = byId.get(under(path).replace(/^\//, ''))
      if (skill) pluginSkills.push(skill)
      else missingSkills.push(path.split('/').pop() ?? path)
    }
  } else {
    const skillsRoot = under('skills')
    for (const skill of skills) {
      if (skill.id === skillsRoot || skill.id.startsWith(`${skillsRoot}/`)) pluginSkills.push(skill)
    }
  }

  const commands = markdownNames(blobs, under('commands'))
  const agents = markdownNames(blobs, under('agents'))

  const [hooks, mcpServers] = await Promise.all([
    readHooks(under(HOOKS_FILE), blobs, readFile, parsedManifest?.inlineHooks ?? null),
    readMcpServers(under(MCP_CONFIG_FILE), blobs, readFile, parsedManifest?.inlineMcpServers ?? null, declaredBy ?? ''),
  ])

  return {
    manifest: parsedManifest
      ? {
          name: parsedManifest.name,
          description: parsedManifest.description,
          version: parsedManifest.version,
          author: parsedManifest.author,
          homepage: parsedManifest.homepage,
        }
      : null,
    components: { skills: pluginSkills, commands, agents, hooks, mcpServers, missingSkills },
  }
}

/** `commands/review.md` → `review`; `commands/git/commit.md` → `git/commit`. */
function markdownNames(blobs: ReadonlySet<string>, root: string): string[] {
  const names: string[] = []
  const prefix = `${root}/`
  for (const path of blobs) {
    if (!path.startsWith(prefix) || !path.toLowerCase().endsWith('.md')) continue
    const name = path.slice(prefix.length, -3)
    if (name.length > 0 && !name.startsWith('.')) names.push(name)
  }
  return names.sort()
}

type ParsedPluginManifest = PluginManifest & {
  inlineHooks: unknown
  inlineMcpServers: unknown
}

function parsePluginManifest(raw: string | null): ParsedPluginManifest | null {
  const parsed = parseJsonObject(raw)
  if (!parsed) return null
  return {
    name: stringOf(parsed.name),
    description: stringOf(parsed.description),
    version: stringOf(parsed.version),
    author: authorName(parsed.author),
    homepage: stringOf(parsed.homepage),
    inlineHooks: isObject(parsed.hooks) ? parsed.hooks : null,
    inlineMcpServers: isObject(parsed.mcpServers) ? parsed.mcpServers : null,
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────

async function readHooks(
  path: string,
  blobs: ReadonlySet<string>,
  readFile: PluginFileReader,
  inline: unknown
): Promise<ScannedPluginHook[]> {
  const hooks: ScannedPluginHook[] = []
  if (inline) hooks.push(...parseHooks(inline))
  if (blobs.has(path)) {
    const raw = await readFile(path)
    const parsed = parseJsonObject(raw)
    if (parsed) hooks.push(...parseHooks(parsed))
  }
  return hooks
}

/**
 * Both shapes Claude Code accepts: `{ hooks: { Event: [...] } }` and the bare
 * `{ Event: [...] }`. Every command is kept verbatim — it is what the trust
 * prompt shows, and rewriting it would show something other than what runs.
 */
export function parseHooks(value: unknown): ScannedPluginHook[] {
  if (!isObject(value)) return []
  const events = isObject(value.hooks) ? value.hooks : value
  const hooks: ScannedPluginHook[] = []
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isObject(group)) continue
      const matcher = stringOf(group.matcher)
      const entries = Array.isArray(group.hooks) ? group.hooks : [group]
      for (const hook of entries) {
        if (!isObject(hook)) continue
        const command = stringOf(hook.command)
        if (command === '') continue
        hooks.push({ event, matcher, command })
      }
    }
  }
  return hooks
}

// ── MCP servers ─────────────────────────────────────────────────────────────

async function readMcpServers(
  path: string,
  blobs: ReadonlySet<string>,
  readFile: PluginFileReader,
  inline: unknown,
  declaredBy: string
): Promise<ScannedMcpServer[]> {
  const servers: ScannedMcpServer[] = []
  if (inline) servers.push(...parseMcpServers(inline, `${declaredBy || 'plugin'}/${CLAUDE_PLUGIN_MANIFEST_PATH}`, declaredBy))
  if (blobs.has(path)) {
    const parsed = parseJsonObject(await readFile(path))
    if (parsed) servers.push(...parseMcpServers(parsed, path, declaredBy))
  }
  return dedupeServers(servers)
}

/**
 * Both shapes `.mcp.json` takes in the wild: the `mcpServers` wrapper, and the
 * bare map of id → config that `claude-plugins-official/plugins/example-plugin`
 * ships. An entry naming neither a command nor a URL is not a server.
 */
export function parseMcpServers(value: unknown, declaredIn: string, declaredBy: string): ScannedMcpServer[] {
  if (!isObject(value)) return []
  const map = isObject(value.mcpServers) ? value.mcpServers : value
  const servers: ScannedMcpServer[] = []
  for (const [id, raw] of Object.entries(map)) {
    if (!isObject(raw) || !/^[A-Za-z0-9._-]+$/.test(id)) continue
    const type = stringOf(raw.type).trim()
    const url = stringOf(raw.url).trim()
    const command = stringOf(raw.command).trim()
    const transport: ScannedMcpServer['transport'] =
      type === 'http' || type === 'sse' ? type : url ? 'http' : 'stdio'
    if (transport === 'stdio' && command === '') continue
    if (transport !== 'stdio' && url === '') continue
    const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : []
    const env = stringRecord(raw.env)
    const headers = stringRecord(raw.headers)
    servers.push({
      id,
      name: id,
      description: stringOf(raw.description),
      transport,
      command,
      args,
      url,
      env,
      envVarNames: envVarNames([...Object.values(env), ...Object.values(headers), ...args, url, command]),
      headers,
      declaredIn,
      declaredBy,
    })
  }
  return servers
}

/**
 * The MCP registry's `server.json`: `remotes[]` give a URL, `packages[]` an
 * npm/pypi identifier the runtime runs. Only what the manifest states becomes
 * a server; a package with no runtime hint is left out rather than guessed at.
 */
export function parseMcpRegistryManifest(value: unknown, declaredIn: string): ScannedMcpServer[] {
  if (!isObject(value)) return []
  const name = stringOf(value.name)
  const id = (name.split('/').pop() ?? name).replace(/[^A-Za-z0-9._-]/g, '-') || 'server'
  const description = stringOf(value.description)
  const servers: ScannedMcpServer[] = []
  const remotes = Array.isArray(value.remotes) ? value.remotes : []
  for (const remote of remotes) {
    if (!isObject(remote)) continue
    const url = stringOf(remote.url).trim()
    if (url === '') continue
    const type = stringOf(remote.type)
    const headers = headerRecord(remote.headers)
    servers.push({
      id,
      name: id,
      description,
      transport: type.includes('sse') ? 'sse' : 'http',
      command: '',
      args: [],
      url,
      env: {},
      envVarNames: envVarNames([url, ...Object.values(headers)]),
      headers,
      declaredIn,
      declaredBy: '',
    })
    break
  }
  if (servers.length > 0) return servers
  const packages = Array.isArray(value.packages) ? value.packages : []
  for (const pkg of packages) {
    if (!isObject(pkg)) continue
    const registry = stringOf(pkg.registryType ?? pkg.registry_type ?? pkg.registryName).toLowerCase()
    const identifier = stringOf(pkg.identifier ?? pkg.name).trim()
    if (identifier === '') continue
    const launch = registry === 'npm' ? { command: 'npx', args: ['-y', identifier] }
      : registry === 'pypi' ? { command: 'uvx', args: [identifier] }
      : null
    if (!launch) continue
    const envNames = Array.isArray(pkg.environmentVariables ?? pkg.environment_variables)
      ? ((pkg.environmentVariables ?? pkg.environment_variables) as unknown[])
          .map((variable) => (isObject(variable) ? stringOf(variable.name) : ''))
          .filter((variable) => variable !== '')
      : []
    servers.push({
      id,
      name: id,
      description,
      transport: 'stdio',
      command: launch.command,
      args: launch.args,
      url: '',
      env: {},
      envVarNames: envNames,
      headers: {},
      declaredIn,
      declaredBy: '',
    })
    break
  }
  return servers
}

async function readRootServers(blobs: ReadonlySet<string>, readFile: PluginFileReader): Promise<ScannedMcpServer[]> {
  const servers: ScannedMcpServer[] = []
  if (blobs.has(MCP_CONFIG_FILE)) {
    const parsed = parseJsonObject(await readFile(MCP_CONFIG_FILE))
    if (parsed) servers.push(...parseMcpServers(parsed, MCP_CONFIG_FILE, ''))
  }
  if (blobs.has(MCP_REGISTRY_MANIFEST)) {
    const parsed = parseJsonObject(await readFile(MCP_REGISTRY_MANIFEST))
    if (parsed) servers.push(...parseMcpRegistryManifest(parsed, MCP_REGISTRY_MANIFEST))
  }
  return servers
}

function dedupeServers(servers: readonly ScannedMcpServer[]): ScannedMcpServer[] {
  const seen = new Set<string>()
  const out: ScannedMcpServer[] = []
  for (const server of servers) {
    const key = `${server.declaredBy} ${server.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(server)
  }
  return out
}

/** `${CONTEXT7_API_KEY:-}` and `$CONTEXT7_API_KEY` both name an env var. */
function envVarNames(values: readonly string[]): string[] {
  const names = new Set<string>()
  for (const value of values) {
    for (const match of value.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)) names.add(match[1])
  }
  return [...names].sort()
}

// ── Marketplace manifest ────────────────────────────────────────────────────

type MarketplaceEntry = {
  name: string
  displayName: string
  description: string
  version: string
  category: string
  author: string
  homepage: string
  source: Extract<ScannedPluginOrigin, { kind: 'in-tree' | 'linked' }>
  skills: string[]
}

type MarketplaceManifest = { name: string; plugins: MarketplaceEntry[] }

/**
 * The marketplace's plugin list. A `source` is a relative path (in this
 * tree) or an object naming another repository: `git-subdir` and `url` are
 * what anthropics/claude-plugins-official ships; `github` and `git` are the
 * documented siblings. An entry whose source cannot be placed is listed as
 * linked with no repository, so the surface can say it is hosted elsewhere.
 */
export function parseMarketplaceManifest(raw: string | null): MarketplaceManifest | null {
  const parsed = parseJsonObject(raw)
  if (!parsed || !Array.isArray(parsed.plugins)) return null
  const plugins: MarketplaceEntry[] = []
  const seen = new Set<string>()
  for (const item of parsed.plugins) {
    if (!isObject(item)) continue
    const name = stringOf(item.name).trim()
    if (name === '' || seen.has(name)) continue
    const source = parseEntrySource(item.source)
    if (!source) continue
    seen.add(name)
    plugins.push({
      name,
      displayName: stringOf(item.displayName),
      description: stringOf(item.description),
      version: stringOf(item.version),
      category: stringOf(item.category),
      author: authorName(item.author),
      homepage: stringOf(item.homepage),
      source,
      skills: Array.isArray(item.skills)
        ? item.skills.filter((skill): skill is string => typeof skill === 'string')
        : [],
    })
  }
  return { name: stringOf(parsed.name).trim(), plugins }
}

function parseEntrySource(value: unknown): MarketplaceEntry['source'] | null {
  if (typeof value === 'string') {
    const path = normalizeRelative(value)
    if (path.split('/').some((segment) => segment === '..')) return null
    return { kind: 'in-tree', path }
  }
  if (!isObject(value)) return null
  const kind = stringOf(value.source)
  const path = normalizeRelative(stringOf(value.path))
  const ref = stringOf(value.ref)
  const sha = stringOf(value.sha)
  if (kind === 'github') {
    const repo = stringOf(value.repo).trim()
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null
    return { kind: 'linked', repo, ref, sha, path, url: `https://github.com/${repo}` }
  }
  const url = stringOf(value.url).trim()
  if (url === '') return null
  return { kind: 'linked', repo: githubRepoFromUrl(url), ref, sha, path, url }
}

/** `https://github.com/o/r.git` → `o/r`; '' for anything not on github.com. */
export function githubRepoFromUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return ''
  }
  if (url.hostname.toLowerCase() !== 'github.com') return ''
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) return ''
  const repo = segments[1].endsWith('.git') ? segments[1].slice(0, -4) : segments[1]
  if (!/^[A-Za-z0-9._-]+$/.test(segments[0]) || !/^[A-Za-z0-9._-]+$/.test(repo)) return ''
  return `${segments[0]}/${repo}`
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findPluginDirs(blobs: ReadonlySet<string>): string[] {
  const dirs: string[] = []
  for (const path of blobs) {
    if (path === CLAUDE_PLUGIN_MANIFEST_PATH) dirs.push('')
    else if (path.endsWith(`/${CLAUDE_PLUGIN_MANIFEST_PATH}`)) {
      dirs.push(path.slice(0, -(CLAUDE_PLUGIN_MANIFEST_PATH.length + 1)))
    }
  }
  return dirs.sort()
}

function deriveShape(counts: { marketplace: boolean; plugins: number; skills: number; servers: number }): SourceShape {
  if (counts.marketplace) return 'claude-marketplace'
  if (counts.plugins > 0) return 'claude-plugin'
  if (counts.servers > 0 && counts.skills > 0) return 'mixed'
  if (counts.servers > 0) return 'mcp-server'
  if (counts.skills > 0) return 'skills'
  return 'empty'
}

function normalizeRelative(value: string): string {
  return value.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function authorName(value: unknown): string {
  if (typeof value === 'string') return value
  return isObject(value) ? stringOf(value.name) : ''
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {}
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') record[key] = entry
  }
  return record
}

/** `server.json` headers are `[{ name, value }]`; `.mcp.json` headers are a map. */
function headerRecord(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const record: Record<string, string> = {}
    for (const header of value) {
      if (!isObject(header)) continue
      const name = stringOf(header.name)
      if (name !== '') record[name] = stringOf(header.value)
    }
    return record
  }
  return stringRecord(value)
}
