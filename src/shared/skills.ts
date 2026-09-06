// Skill sources: the shapes the whole Skills surface is built on.
//
// A *source* is somewhere skills come from — the skills Multicode ships
// (`builtin`), the skills its connector catalogue ships (`connectors`), or any
// public GitHub repository the user adds (`github`). Scanning a source turns it
// into a list of skills; a skill is a directory containing SKILL.md, taken
// whole.
//
// Renderer-safe on purpose (no node imports): the Extensions surface, the
// reader, and the main-process scanner all speak these types.

export type SkillSourceKind = 'builtin' | 'connectors' | 'github' | 'local'

/**
 * An agent CLI that reads workspace skills. Which directory each one reads is
 * `SKILL_HARNESS_DIR` in src/shared/skill-harnesses.ts; this is the identity
 * alone, so renderer code can name a harness without importing a node module.
 */
export type SkillHarness = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'grok' | 'agents'

/** A place skills come from. `repo` is `owner/name` for github, '' otherwise. */
export type SkillSource = {
  id: string
  kind: SkillSourceKind
  name: string
  repo: string
  /**
   * Absolute folder path for a `local` source, '' for every other kind. A
   * folder on this machine is a source you can point at (the source-tabs
   * ruling, 2026-09-05: the plus offers "Add from file…" beside "Add from
   * GitHub…"), and the path is the only identity it has — there is no
   * repository to name it by.
   */
  path?: string
  /** 1-2 character badge shown in the source rail. */
  monogram: string
  blurb: string
  /** Commit the cached scan was taken at; '' for sources with no git identity. */
  commitSha: string
  /** ISO timestamp of the cached scan; '' when never scanned. */
  scannedAt: string
  /**
   * The repository's head the last update check resolved, when it ran. A head
   * that differs from `commitSha` is an update the person can apply with Sync
   * (backlog/2026-09-05-plugin-sources.md, "Update notifications").
   */
  headSha?: string
  headCheckedAt?: string
}

/** True when a check has seen the source's repository move past the scanned commit. */
export function sourceHasUpdate(source: Pick<SkillSource, 'commitSha' | 'headSha'>): boolean {
  return Boolean(source.headSha) && source.commitSha !== '' && source.headSha !== source.commitSha
}

/**
 * One file inside a skill. `path` is skill-relative with forward slashes, so
 * `agents/openai.yaml` keeps its shape when installed. `blobSha` is the git
 * blob id from the tree listing, and is '' for sources with no git identity.
 */
export type SkillFileRef = {
  path: string
  size: number
  blobSha: string
  isEntry: boolean
}

export type ScannedSkill = {
  /** Source-relative directory path — the skill's identity within its source. */
  id: string
  name: string
  description: string
  /** Group name, or '' when the source carries no grouping signal. */
  group: string
  files: SkillFileRef[]
  allowedTools: string[]
  hasExecutables: boolean
  /**
   * The optional Agent Skills fields, read from the entry document alongside
   * the description (https://agentskills.io/specification, fetched
   * 2026-09-06). Optional on the type because a scan cached before 2026-09-06
   * carries none, and because most skills declare none.
   */
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
}

export type SkillGroupingSignal = 'manifest' | 'folders' | 'none'

export type ScanResult = {
  skills: ScannedSkill[]
  groups: string[]
  groupingSignal: SkillGroupingSignal
  fileCount: number
  commitSha: string
  /**
   * Entry documents that were read and declared no `description`, and so are
   * not skills at all (https://agentskills.io/specification, fetched
   * 2026-09-06). They are dropped from `skills`, and counted here so the
   * surface can say a source held something it did not list. Absent on scans
   * cached before this was counted, which is not the same as zero.
   */
  skippedNoDescription?: number
  /**
   * What the repository turned out to be, and the plugins and MCP servers it
   * declares (backlog/2026-09-05-plugin-sources.md). Optional because scans
   * cached before plugins existed carry none; read them through
   * `scanPlugins()` / `scanMcpServers()` / `scanShape()`, never directly.
   */
  shape?: SourceShape
  /** The `name` a `.claude-plugin/marketplace.json` gives itself; '' without one. */
  marketplaceName?: string
  plugins?: ScannedPlugin[]
  mcpServers?: ScannedMcpServer[]
  /**
   * The marketplace's top-level `renames`: old plugin name → the name it is
   * listed under now. Read through `scanPluginRenames()`, never directly.
   */
  pluginRenames?: Record<string, string>
}

// Plugins and MCP servers: the other two kinds a source can hold.
//
// A *plugin* is Claude Code's bundle shape — `.claude-plugin/plugin.json` over
// `skills/`, `commands/`, `agents/`, `hooks/hooks.json` and `.mcp.json` — or a
// registry entry projected into the same shape. A source lists its plugins
// from its `.claude-plugin/marketplace.json` when it has one (a marketplace),
// else from every plugin manifest in its tree.

export type SourceShape =
  | 'claude-marketplace'
  | 'claude-plugin'
  | 'mcp-server'
  | 'skills'
  | 'mixed'
  | 'empty'

export const SOURCE_SHAPE_LABEL: Record<SourceShape, string> = {
  'claude-marketplace': 'Claude Code plugin marketplace',
  'claude-plugin': 'Claude Code plugin',
  'mcp-server': 'MCP server',
  skills: 'Skills',
  mixed: 'Skills and MCP servers',
  empty: 'Nothing installable',
}

/** Where a plugin's bytes live, which is also where its skills are read from. */
export type ScannedPluginOrigin =
  /** A directory in the source's own tree, '' for the root. */
  | { kind: 'in-tree'; path: string }
  /**
   * A marketplace entry pointing at another repository. `sha` is the commit
   * the marketplace pinned ('' when it pinned none), `path` the directory
   * inside that repository ('' for the root). Its components are unknown until
   * the plugin is opened and that repository is read.
   */
  | { kind: 'linked'; repo: string; ref: string; sha: string; path: string; url: string }
  /** A marketplace-registry entry (the Multicode source). */
  | { kind: 'registry'; entryId: string; sourceUrl: string }

export type ScannedPluginHook = {
  /** `PreToolUse`, `Stop`, … — the event as the plugin names it. */
  event: string
  /** The tool matcher, '' when the hook fires on every tool. */
  matcher: string
  /** The shell command, verbatim. This is what the trust prompt shows. */
  command: string
}

/**
 * An MCP server a source declares, in the shape `McpServerConfig` takes once
 * installed. `declaredIn` is the repo-relative path of the file that declared
 * it; `declaredBy` the plugin id when a plugin ships it, '' otherwise.
 */
export type ScannedMcpServer = {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  envVarNames: string[]
  headers: Record<string, string>
  declaredIn: string
  declaredBy: string
}

/**
 * A language server a plugin declares. Claude Code starts it for the file
 * extensions the manifest maps, so those are what the surface can honestly say
 * the plugin covers — the twelve `*-lsp` plugins in
 * `anthropics/claude-plugins-official` are nothing BUT this declaration, their
 * directories holding a LICENSE and a README and no manifest at all.
 * `startupTimeout` is milliseconds and 0 when the manifest states none.
 */
export type ScannedLspServer = {
  /** The key the declaration is filed under: `clangd`, `rust-analyzer`, … */
  id: string
  command: string
  args: string[]
  /** `.ts` → `typescript`, verbatim from the manifest. */
  extensionToLanguage: Record<string, string>
  startupTimeout: number
  /** Repo-relative path of the file that declared it. */
  declaredIn: string
  /** The plugin id, '' when nothing named one. */
  declaredBy: string
}

export type ScannedPluginComponents = {
  /** The plugin's skills, whole: read from wherever the plugin's bytes live. */
  skills: ScannedSkill[]
  /** Command names (`commands/<name>.md`). */
  commands: string[]
  /** Agent names (`agents/<name>.md`). */
  agents: string[]
  hooks: ScannedPluginHook[]
  mcpServers: ScannedMcpServer[]
  /**
   * Language servers, a component kind of its own rather than a footnote on the
   * MCP servers: an LSP server is started per file extension by the editor
   * integration and is not an MCP endpoint at all, and a plugin can consist of
   * nothing else.
   */
  lspServers: ScannedLspServer[]
  /** Skills the entry names but that shipped with no readable directory. */
  missingSkills: string[]
}

export type ScannedPlugin = {
  /** The marketplace name, or the manifest name, or the directory name. */
  id: string
  name: string
  description: string
  version: string
  category: string
  author: string
  homepage: string
  origin: ScannedPluginOrigin
  /**
   * Whether the marketplace requires this entry to validate strictly. Absent in
   * a manifest means true, which is the marketplace schema's own default, so
   * only `strict: false` is ever written — and it is written by fourteen of the
   * official marketplace's entries, which is why dropping it made those look
   * like every other entry.
   */
  strict: boolean
  /** Curation labels the marketplace applies, e.g. `community-managed`. */
  tags: string[]
  /** Search words the entry gives itself; distinct from `tags`, which curate. */
  keywords: string[]
  /**
   * False for a linked plugin whose repository has not been read yet: its
   * components are unknown, not empty, and the surface must say so.
   */
  componentsKnown: boolean
  components: ScannedPluginComponents
  /**
   * For a linked plugin: whether its own repository was read, and why not when
   * it was not (linked-plugins ruling, 2026-09-06). Absent on an in-tree
   * plugin, and on a scan cached before the scan followed anything — which is
   * why `componentsKnown` stays the authority on whether the components are
   * known and this only ever explains it.
   */
  linkedRead?: LinkedPluginReadState
}

/**
 * Why a linked plugin's components are or are not in hand.
 *
 * A scan follows linked plugins within a budget (`MAX_LINKED_REPOSITORY_READS`
 * in src/main/skills/scan-plugins.ts), so "not read" splits into two very
 * different facts: one a later scan will fix by itself, and one no amount of
 * scanning will. Saying which is the whole point — 238 rows reading "Read when
 * opened" told a person nothing about whether opening one would work.
 */
export type LinkedPluginReadState =
  /** Its repository was listed at the pinned commit and its components are real. */
  | { status: 'read' }
  /**
   * Nothing was fetched for it: this pass's budget ran out, or GitHub's rate
   * limit did. The next scan resumes where this one stopped, because every
   * plugin already read is cached against its pinned sha and costs nothing.
   */
  | { status: 'pending'; reason: 'budget' | 'rate-limited' }
  /** Reading it was refused or failed in a way a retry will not change. */
  | { status: 'unreadable'; message: string }

/** How much of a source's linked population is read, for the head line. */
export type LinkedPluginSummary = {
  total: number
  read: number
  pending: number
  unreadable: number
}

export function summariseLinkedPlugins(scan: Pick<ScanResult, 'plugins'>): LinkedPluginSummary {
  const summary: LinkedPluginSummary = { total: 0, read: 0, pending: 0, unreadable: 0 }
  for (const plugin of scanPlugins(scan)) {
    if (plugin.origin.kind !== 'linked') continue
    summary.total += 1
    if (plugin.componentsKnown) summary.read += 1
    else if (plugin.linkedRead?.status === 'unreadable') summary.unreadable += 1
    else summary.pending += 1
  }
  return summary
}

/**
 * The head line's admission that a scan is partial, or null when there is
 * nothing to admit. A source with no linked plugins, and one whose linked
 * plugins are all read, say nothing extra — the counts already stand.
 *
 * The token is named only when there is not one: at 60 unauthenticated
 * requests an hour the budget is 20 repositories a scan, and "add a GitHub
 * token" is the action that turns twelve scans into one (linked-plugins
 * ruling, 2026-09-06). With a token in place the honest next step is Sync,
 * which resumes from what is already cached.
 */
export function linkedPluginShortfallLine(
  summary: LinkedPluginSummary,
  tokenConfigured: boolean
): string | null {
  const parts: string[] = []
  if (summary.pending > 0) {
    parts.push(
      `${summary.pending} of ${summary.total} linked plugins not yet read — ${
        tokenConfigured ? 'Sync to read the rest' : 'add a GitHub token'
      }`
    )
  }
  if (summary.unreadable > 0) {
    parts.push(
      `${summary.unreadable} of ${summary.total} linked ${summary.unreadable === 1 ? 'plugin' : 'plugins'} could not be read`
    )
  }
  return parts.length > 0 ? parts.join('; ') : null
}

/**
 * A scan's plugins, with every field this build requires actually present.
 *
 * Scans are cached verbatim beside their source and are never migrated, so a
 * cache written before a field existed holds plugins without it. That is not a
 * cosmetic gap: `plugin.components.lspServers.length` on one of those throws
 * where the row is drawn, which takes the whole Plugins tab down — and Sync,
 * the only thing that would replace the cache, sits behind that render. Every
 * reader goes through here, so the gap is filled on the way out instead.
 *
 * A plugin that already has everything is returned as it is: a source scanned
 * by this build pays one shape check per plugin and allocates nothing.
 */
export function scanPlugins(scan: Pick<ScanResult, 'plugins'>): ScannedPlugin[] {
  const plugins = scan.plugins ?? []
  return plugins.every(isCompleteScannedPlugin) ? plugins : plugins.map(completeScannedPlugin)
}

function isCompleteScannedPlugin(plugin: ScannedPlugin): boolean {
  const components = plugin.components as Partial<ScannedPluginComponents> | undefined
  if (!components) return false
  return (
    typeof plugin.strict === 'boolean'
    && Array.isArray(plugin.tags)
    && Array.isArray(plugin.keywords)
    && Array.isArray(components.skills)
    && Array.isArray(components.commands)
    && Array.isArray(components.agents)
    && Array.isArray(components.hooks)
    && Array.isArray(components.mcpServers)
    && Array.isArray(components.lspServers)
    && Array.isArray(components.missingSkills)
  )
}

/**
 * The defaults a missing field takes: empty for every list, and `strict: true`
 * for the flag, which is the marketplace schema's own default. Nothing is
 * invented — an absent list becomes an empty one, which is what an older scan
 * knowing nothing about a component kind actually means.
 */
function completeScannedPlugin(plugin: ScannedPlugin): ScannedPlugin {
  const stored = (plugin.components ?? {}) as Partial<ScannedPluginComponents>
  const empty = emptyPluginComponents()
  const list = <T,>(value: T[] | undefined, fallback: T[]): T[] => (Array.isArray(value) ? value : fallback)
  return {
    ...plugin,
    strict: typeof plugin.strict === 'boolean' ? plugin.strict : true,
    tags: list(plugin.tags, []),
    keywords: list(plugin.keywords, []),
    components: {
      skills: list(stored.skills, empty.skills),
      commands: list(stored.commands, empty.commands),
      agents: list(stored.agents, empty.agents),
      hooks: list(stored.hooks, empty.hooks),
      mcpServers: list(stored.mcpServers, empty.mcpServers),
      lspServers: list(stored.lspServers, empty.lspServers),
      missingSkills: list(stored.missingSkills, empty.missingSkills),
    },
  }
}

export function scanMcpServers(scan: Pick<ScanResult, 'mcpServers'>): ScannedMcpServer[] {
  return scan.mcpServers ?? []
}

/** The shape, derived when the scan predates the field. */
export function scanShape(scan: ScanResult): SourceShape {
  if (scan.shape) return scan.shape
  return scan.skills.length > 0 ? 'skills' : 'empty'
}

export function emptyPluginComponents(): ScannedPluginComponents {
  return { skills: [], commands: [], agents: [], hooks: [], mcpServers: [], lspServers: [], missingSkills: [] }
}

/**
 * The marketplace's `renames` map, old name → the name it lists the plugin
 * under now. Carried whole rather than resolved at scan time: the map may name
 * a plugin the listing no longer holds, and a lookup that silently dropped
 * those would answer "no such plugin" for a name the marketplace explicitly
 * accounts for.
 */
export function scanPluginRenames(scan: Pick<ScanResult, 'pluginRenames'>): Record<string, string> {
  return scan.pluginRenames ?? {}
}

/**
 * Every name a plugin has answered to: the names `renames` points AT it, and
 * the id it goes by now. This is what a receipt written before an upstream
 * rename has to be matched against — `anthropics/claude-plugins-official`
 * renamed `adlc` to `agentforce-adlc`, and without the map the plugin a person
 * installed reads as not installed and installing it again duplicates it.
 */
export function pluginAliases(renames: Readonly<Record<string, string>>, pluginId: string): string[] {
  const aliases = new Set<string>([pluginId])
  for (const [was, now] of Object.entries(renames)) {
    if (now === pluginId) aliases.add(was)
  }
  return [...aliases]
}

/** A plugin by the name it goes by now, or by any name `renames` points at it. */
export function findScannedPlugin(
  scan: Pick<ScanResult, 'plugins' | 'pluginRenames'>,
  pluginId: string,
): ScannedPlugin | null {
  const plugins = scanPlugins(scan)
  const direct = plugins.find((plugin) => plugin.id === pluginId)
  if (direct) return direct
  const renamed = scanPluginRenames(scan)[pluginId]
  if (!renamed) return null
  return plugins.find((plugin) => plugin.id === renamed) ?? null
}

/**
 * Why a plugin's components are unknown — the two reasons are not the same
 * promise.
 *
 * `unopened`: a linked plugin, whose bytes are in another repository and are
 * fetched the moment it is opened. `over-scan-limit`: an in-tree plugin the
 * scan did not read because the source lists more plugins than one scan reads.
 * Opening that one reads nothing, so telling a person to open it — which is
 * what this said until 2026-09-06 — sends them to press a button that cannot
 * work and leaves Install refusing with no reason given.
 */
export function unreadPluginReason(
  plugin: Pick<ScannedPlugin, 'componentsKnown' | 'origin'>,
): 'read' | 'unopened' | 'over-scan-limit' {
  if (plugin.componentsKnown) return 'read'
  return plugin.origin.kind === 'linked' ? 'unopened' : 'over-scan-limit'
}

/**
 * The words a row uses for what a plugin ships: "4 skills · 2 commands · 1 MCP".
 *
 * An unread linked plugin says WHY it is unread rather than the flat "Read when
 * opened" it said before the scan followed any of them (linked-plugins ruling,
 * 2026-09-06): a repository off the allowlist and a repository this pass simply
 * had no budget left for are different promises, and 238 rows making the same
 * one said nothing about which.
 */
export function describePluginComponents(plugin: ScannedPlugin): string {
  if (!plugin.componentsKnown) {
    if (unreadPluginReason(plugin) !== 'unopened') return 'Not read by this scan'
    const state = plugin.linkedRead
    if (!state || state.status === 'read') return 'Read when opened'
    if (state.status === 'unreadable') return state.message
    return state.reason === 'rate-limited'
      ? 'Not read — GitHub rate limit reached'
      : 'Not read yet — read when opened'
  }
  const c = plugin.components
  const parts: string[] = []
  const count = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`)
  }
  count(c.skills.length, 'skill', 'skills')
  count(c.commands.length, 'command', 'commands')
  count(c.agents.length, 'agent', 'agents')
  count(c.mcpServers.length, 'MCP', 'MCP')
  count(c.lspServers.length, 'LSP server', 'LSP servers')
  count(c.hooks.length, 'hook', 'hooks')
  return parts.length > 0 ? parts.join(' · ') : 'No components declared'
}

export type SkillSourceLayout = 'solo' | 'flat' | 'grouped' | 'search' | 'none'

export const SKILL_ENTRY_FILE = 'SKILL.md'

/** Group name for skills that sit directly at a source's root. */
export const SKILL_REPO_ROOT_GROUP = '(repo root)'

/**
 * Group name for skills a `.claude-plugin/marketplace.json` does not list.
 *
 * The Agent Skills specification defines no collection manifest, so a manifest
 * is a source's own grouping and never its census: a directory with a SKILL.md
 * that the manifest forgot is still a skill, and must not vanish because a
 * plugin list omitted it (anthropics/skills' `template/` is the visible case).
 *
 * The renderer's own fallback heading for a group the scan did not list is this
 * same constant, so a source never shows two headings meaning the same thing. A
 * manifest that authors a group of this name absorbs the unlisted skills into
 * it: one heading, every skill reachable, which is the better of the two ways
 * that collision can go.
 */
export const SKILL_UNLISTED_GROUP = 'Everything else'

export const BUILTIN_SKILL_SOURCE_ID = 'builtin'
export const CONNECTORS_SKILL_SOURCE_ID = 'connectors'

// Claude Code's own plugin marketplace, an always-present source since the
// official-plugins ruling (2026-09-06). Its id is the one `addSource` would
// have minted for it, so someone who pastes the repository into "Add from
// GitHub…" is told they already have it rather than getting a second tab of the
// same 292 plugins.
export const OFFICIAL_PLUGINS_SKILL_SOURCE_REPO = 'anthropics/claude-plugins-official'
export const OFFICIAL_PLUGINS_SKILL_SOURCE_ID = `github:${OFFICIAL_PLUGINS_SKILL_SOURCE_REPO}`
/** What that source is CALLED: the publisher, not the repository path. */
export const OFFICIAL_PLUGINS_SKILL_SOURCE_NAME = 'Anthropic'

/**
 * A source every install has and nobody can remove. The store is the authority
 * (`ALWAYS_PRESENT_SKILL_SOURCES` in main), but the renderer has to know too —
 * offering "Remove source" on a tab that refuses to go is an action that
 * reports a failure the person could not have avoided.
 */
export function isBundledSkillSource(id: string): boolean {
  return (
    id === BUILTIN_SKILL_SOURCE_ID
    || id === CONNECTORS_SKILL_SOURCE_ID
    || id === OFFICIAL_PLUGINS_SKILL_SOURCE_ID
  )
}

/** Every local source's id is this prefix plus its absolute path. */
export const LOCAL_SKILL_SOURCE_ID_PREFIX = 'local:'

/** The last path segment — what a folder source is called on screen. */
export function localSourceFolderName(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : path
}

/**
 * How a source's skill list should be presented. Derived on read, never
 * persisted: the same scan renders differently as a repository grows, and a
 * stored layout would go stale the moment Sync moved the commit.
 *
 * A grouped source stays browsable much further than a flat one, because the
 * groups do the narrowing a search box would otherwise have to do.
 */
export function sourceLayout(result: ScanResult): SkillSourceLayout {
  const count = result.skills.length
  if (count === 0) return 'none'
  if (count === 1) return 'solo'
  if (result.groupingSignal !== 'none' && result.groups.length > 0) {
    return count <= 60 ? 'grouped' : 'search'
  }
  return count <= 24 ? 'flat' : 'search'
}

// Discover: finding a skill you do not already have the repository for.
//
// Repository search matches a repo's name, description and README, so it finds
// repos that *mention* a capability. Code search matches inside `SKILL.md`, so
// it finds skills that *do* it — including skills vendored inside repos that are
// not skill collections at all. Discover produces candidates; scanning one is
// the existing add-a-source path.

/**
 * Why a Discover query could not answer in full. Always stated: an empty list
 * with no condition means "GitHub has no match", and nothing else may borrow
 * that meaning.
 */
export type SkillDiscoveryCondition = {
  reason: 'needs_token' | 'rate_limited' | 'query_too_short' | 'unavailable'
  message: string
  /** Seconds until the limit resets; 0 when GitHub did not say, or not a limit. */
  retryAfterSeconds: number
}

/** What GitHub reported about the budget the query spent from. */
export type SkillRateLimit = {
  limit: number
  remaining: number
  /** ISO timestamp the window resets at; '' when GitHub did not say. */
  resetAt: string
}

/** One skill found inside a repository — a candidate to scan, not a source. */
export type SkillSearchHit = {
  /** `owner/name`. */
  repo: string
  /** Repo-relative path of the matched SKILL.md. */
  path: string
  /** Directory holding the skill — its id once the repo is scanned; '' at the root. */
  skillId: string
  /** From the matched frontmatter, falling back to the directory name. */
  name: string
  /** From the matched frontmatter; '' when the fragment carried none. */
  description: string
  htmlUrl: string
}

/**
 * A repository Discover offers to scan. It carries no skill count on purpose:
 * the count is unknown until the repo is scanned, and stars do not predict it —
 * one 52k-star repo holds a single skill while a 4.9k-star one holds 103.
 */
export type SkillRepoHit = {
  repo: string
  description: string
  /** null when the result did not come with a star count — never shown as 0. */
  stars: number | null
  htmlUrl: string
  /** Carries `.claude-plugin/marketplace.json`: someone curated the contents. */
  curated: boolean
}

export type SkillDiscoveryResult<T> = {
  results: T[]
  rateLimit: SkillRateLimit | null
  degraded: SkillDiscoveryCondition | null
}

/** Shortest query code search is asked to run; below it GitHub matches everything. */
export const MIN_SKILL_SEARCH_QUERY_LENGTH = 3

// Agent capabilities: what the agent in one terminal can actually reach.
//
// Derived on demand from the harness directories and CLI config files, never
// from a record of what we intended to install — someone who hand-edits
// `.claude/skills` or `.mcp.json` sees the result here. One query answers the
// whole question so no surface joins several calls and drifts from the next.

/** Where an installed skill directory came from, read from its provenance marker. */
export type AgentSkillSource = 'builtin' | 'source' | 'local'

export type AgentSkill = {
  /** Directory name, which is the skill's identity to every CLI that reads it. */
  id: string
  name: string
  /** '' when the SKILL.md carries no description; never invented copy. */
  description: string
  /** How to invoke it in this CLI, rendered from the plugin's own template. */
  invocation: string
  source: AgentSkillSource
  /**
   * Every CLI bound to this harness. The skill lives in one directory, and each
   * of these can read it — this is the attribution that stops a shared skill
   * being counted once per CLI.
   */
  pluginIds: string[]
}

/**
 * An MCP server a CLI is configured with, read from that CLI's own config file
 * by the format adapter its manifest declares. Configured, not necessarily
 * loaded: a config that marks a server disabled still declares it, and both
 * CLIs that express that state list it as disabled rather than omitting it, so
 * dropping it here would hide something the user wrote.
 */
export type AgentMcpServer = {
  id: string
  transport: string
  /** Absent unless the config states it — a count is never guessed. */
  toolCount?: number
  /** Which of the CLI's two declared config files this entry won from. */
  scope: 'workspace' | 'user'
  configPath: string
}

/**
 * Why one path could not be read, or could not be kept true. A union, not a
 * boolean: `malformed` (a file that opened but could not be parsed) is a
 * different fault from one that could not be opened at all, and the likeliest
 * real-world one for a config file. `watch_unavailable` is not a read failure
 * at all — the answer is correct as of the read and may go stale.
 */
export type CapabilityDiagnosticReason = 'unreadable' | 'malformed' | 'watch_unavailable'

/**
 * Which half of the answer a fault belongs to, or `freshness` for one that
 * belongs to neither: a path that could not be watched leaves both halves
 * readable but possibly stale, which a surface must say differently from a
 * half that failed to read.
 */
export type CapabilityKind = 'skills' | 'servers' | 'freshness'

export type CapabilityDiagnostic = {
  /**
   * A surface that renders one half must not be blanked by the other half's
   * fault: an unparseable `.mcp.json` is not a reason to stop listing skills.
   */
  capability: CapabilityKind
  reason: CapabilityDiagnosticReason
  /** The path that failed, so the surface can name it. */
  path: string
  message: string
}

/**
 * Whether installing a bundled skill would actually put it where this harness
 * reads: `all-native` covers every natively-supported CLI, a static list covers
 * the harnesses it names, and the default target (`.agents`, prompt-injected)
 * reaches no CLI's own directory.
 *
 * One rule, because two surfaces ask it — the Skills pane's search-only
 * catalogue and `SkillPickerPopover`'s "available" rows. Offering a skill the
 * attach path will route into some *other* CLI's directory is an Add that
 * reports success and changes nothing for the agent the user is looking at —
 * the picker applied that rule privately, the pane did not apply it at all.
 * It lives here rather than beside either of them because it is a fact about a
 * bundled skill's declared targets, not about how a surface draws them.
 */
export function builtinInstallsIntoHarness(
  skill: { harnesses?: readonly string[]; targetPolicy?: string },
  harnessId: string,
): boolean {
  if (skill.targetPolicy === 'all-native') return true
  return (skill.harnesses ?? []).some((harness) => harness === harnessId)
}

export type AgentCapabilitiesInput = {
  workspaceRoot: string
  pluginId: string
}

/**
 * `ok: false` is reserved for a question that could not be asked (no workspace).
 * A CLI with no skill support, and a harness directory that was never created,
 * are both `ok: true` with a stated `support` — an unavailable capability is a
 * result, never an empty list.
 */
export type AgentCapabilitiesResult =
  | {
      ok: true
      support: 'native' | 'prompt-shim' | 'unsupported'
      /** '' when the plugin declares no skill integration at all. */
      harnessId: string
      skills: AgentSkill[]
      servers: AgentMcpServer[]
      diagnostics: CapabilityDiagnostic[]
    }
  | { ok: false; message: string }

export type AgentCapabilitiesWatchInput = {
  workspaceRoot: string
}

// Named once and imported by both sides: main registering a channel the preload
// spells differently is a failure that only shows up in a running app.
export const AGENT_CAPABILITIES_WATCH_START_CHANNEL = 'skills:agent-capabilities-watch-start'
export const AGENT_CAPABILITIES_WATCH_STOP_CHANNEL = 'skills:agent-capabilities-watch-stop'
export const AGENT_CAPABILITIES_INVALIDATED_CHANNEL = 'skills:agent-capabilities-invalidated'

/**
 * "Ask again" — never the new answer. One per `(workspaceRoot, harnessId)`
 * after the watcher's debounce, so a ten-file install moves the surface once.
 *
 * `harnessId` is the coalescing identity; `pluginIds` says which CLIs' queries
 * it covers, because a CLI can declare an MCP config and no skill integration
 * at all (cursor) and so has no harness id to be addressed by.
 */
export type AgentCapabilitiesInvalidation = {
  workspaceRoot: string
  /** '' when the group is a CLI that declares no skill integration. */
  harnessId: string
  pluginIds: string[]
}

export type SkillFrontmatter = {
  name: string
  description: string
  allowedTools: string[]
  /** The spec's optional `license`; '' when the skill declares none. */
  license: string
  /** The spec's optional `compatibility`; '' when the skill declares none. */
  compatibility: string
  /** The spec's optional `metadata` map; empty when the skill declares none. */
  metadata: Record<string, string>
}

/** Every field blank — what an unreadable or frontmatter-less entry yields. */
export function emptySkillFrontmatter(): SkillFrontmatter {
  return { name: '', description: '', allowedTools: [], license: '', compatibility: '', metadata: {} }
}

/**
 * Read the SKILL.md frontmatter fields the surface discloses — every field the
 * Agent Skills specification defines (https://agentskills.io/specification,
 * fetched 2026-09-06): `name`, `description`, and the optional `license`,
 * `compatibility`, `metadata` and `allowed-tools`.
 *
 * Deliberately not a YAML parser: skill frontmatter is a flat block of scalars
 * plus one map and one tool list, and a real YAML dependency would buy nothing
 * but a larger parse surface for third-party bytes.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  // A byte-order mark sits BEFORE the opening fence, so `^---` never matches a
  // SKILL.md saved by a Windows editor. That used to cost the row its
  // description; since a skill with no description is skipped (2026-09-06) it
  // would cost the skill its row, which is a repository's file deleted from a
  // listing over three invisible bytes.
  const block = stripByteOrderMark(raw).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const result: SkillFrontmatter = emptySkillFrontmatter()
  if (!block) return result

  const lines = block[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const scalar = lines[index].match(/^(name|description|license|compatibility):\s*(.*)$/)
    if (scalar) {
      const inline = unquoteYamlScalar(scalar[2])
      // A folded or literal block (`description: >`) carries its text on the
      // indented lines below. Reading the marker as the value is how a row came
      // to show ">" where its description belongs — `parseSkillFragment` has
      // always folded these, and now both sides of the same file agree.
      const value = isYamlBlockMarker(inline) ? foldedBlockValue(lines, index + 1) : inline
      const key = scalar[1] as 'name' | 'description' | 'license' | 'compatibility'
      // First occurrence wins, as YAML itself would take it.
      if (!result[key]) result[key] = value
      continue
    }
    const meta = lines[index].match(/^metadata:\s*(.*)$/)
    if (meta) {
      if (Object.keys(result.metadata).length === 0) {
        result.metadata = readMetadataMap(lines, index, unquoteYamlScalar(meta[1]))
      }
      continue
    }
    const tools = lines[index].match(/^allowed-tools:\s*(.*)$/)
    if (!tools || result.allowedTools.length > 0) continue
    const inline = unquoteYamlScalar(tools[1])
    if (inline) {
      result.allowedTools = splitToolList(inline)
      continue
    }
    // Block sequence: `allowed-tools:` followed by indented `- ` items.
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor].match(/^\s+-\s*(.+?)\s*$/)
      if (!item) break
      const value = unquoteYamlScalar(item[1])
      if (value) result.allowedTools.push(value)
    }
  }
  return result
}

/**
 * Name and description out of a code-search text-match fragment.
 *
 * The fragment is a window into SKILL.md rather than the whole file, so the
 * `---` fences are usually missing and `parseSkillFrontmatter` would return
 * nothing. Fields it cannot find come back empty: the row then shows the path
 * it did find, never invented copy.
 */
export function parseSkillFragment(fragment: string): { name: string; description: string } {
  const lines = stripByteOrderMark(fragment).split(/\r?\n/)
  const found = { name: '', description: '' }
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^(name|description):\s*(.*)$/)
    if (!field) continue
    const key = field[1] as 'name' | 'description'
    if (found[key]) continue
    const inline = unquoteYamlScalar(field[2])
    found[key] = isYamlBlockMarker(inline) ? foldedBlockValue(lines, index + 1) : inline
  }
  return found
}

function isYamlBlockMarker(value: string): boolean {
  return value === '' || /^[|>][+-]?$/.test(value)
}

/** The indented lines under a folded or empty scalar, joined the way YAML folds them. */
function foldedBlockValue(lines: readonly string[], start: number): string {
  const collected: string[] = []
  for (let cursor = start; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (!/^\s+\S/.test(line)) break
    collected.push(line.trim())
  }
  return collected.join(' ')
}

/**
 * The `metadata` map: a block of indented `key: value` lines under the field,
 * or a flow map on the field's own line. Values are strings, which is all the
 * specification defines the map to hold.
 */
function readMetadataMap(
  lines: readonly string[],
  index: number,
  inline: string
): Record<string, string> {
  const found: Record<string, string> = {}
  if (inline.startsWith('{') && inline.endsWith('}')) {
    for (const pair of inline.slice(1, -1).split(',')) {
      const cut = pair.indexOf(':')
      if (cut === -1) continue
      const key = unquoteYamlScalar(pair.slice(0, cut))
      if (key && !(key in found)) found[key] = unquoteYamlScalar(pair.slice(cut + 1))
    }
    return found
  }
  // A scalar where a map belongs is not a map; reading it as one would invent
  // a key nobody wrote.
  if (inline !== '') return found
  // The map's own indent, taken from its first entry: a deeper line belongs to
  // a nested structure, and reading it here would invent a key at the top level
  // — usually one whose value is the empty string, which then renders as a row
  // stating nothing. The specification's map is string to string.
  let indent = -1
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const entry = lines[cursor].match(/^(\s+)([^\s:][^:]*):\s*(.*)$/)
    if (!entry) break
    if (indent === -1) indent = entry[1].length
    if (entry[1].length > indent) continue
    if (entry[1].length < indent) break
    const key = unquoteYamlScalar(entry[2])
    if (key && !(key in found)) found[key] = unquoteYamlScalar(entry[3])
  }
  return found
}

/**
 * The tools an `allowed-tools` scalar names.
 *
 * The Agent Skills specification (https://agentskills.io/specification, fetched
 * 2026-09-06) writes this field as a SPACE-separated string, and its own
 * example — `Bash(git:*) Bash(jq:*) Read` — is three tools. Splitting on commas
 * alone, which is what this did until 2026-09-06, read that example as one
 * bogus tool name. Commas still separate too, because the YAML flow form
 * (`[Read, Write]`) and the comma-separated form Claude Code's own
 * documentation used are both in the wild and neither is ambiguous.
 *
 * A separator inside parentheses or quotes belongs to the tool's own argument
 * pattern (`Bash(npx impeccable *)`), so those do not split.
 */
function splitToolList(value: string): string[] {
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  const tokens: string[] = []
  let current = ''
  let depth = 0
  let quote = ''
  for (const char of inner) {
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if ((char === '"' || char === "'") && depth === 0 && current === '') {
      // A quote only QUOTES at the start of a token: the apostrophe in
      // `Bash(don't:*)` is part of a command, and reading it as an opening quote
      // swallowed the rest of the line into one bogus tool name.
      quote = char
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (char === ',' || /\s/.test(char))) {
      tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  tokens.push(current)
  return tokens.map((token) => unquoteYamlScalar(token)).filter((token) => token.length > 0)
}

/**
 * One character of a conformant `name`. The specification says "unicode
 * lowercase alphanumeric characters (`a-z`, `0-9`) and hyphens", so the test is
 * alphanumeric-and-already-lowercase rather than ASCII: `café-export` is a name
 * a repository may legitimately ship, `PDF-Processing` is the one the spec's own
 * invalid example rejects, and a script without case (`日本語`) is its own
 * lowercase.
 */
function isSpecNameCharacter(char: string): boolean {
  if (char === '-') return true
  if (!/[\p{L}\p{N}]/u.test(char)) return false
  return char === char.toLowerCase()
}

/** The longest `name` the specification allows. */
const SKILL_NAME_MAX_LENGTH = 64

/**
 * How a skill's declared `name` departs from the Agent Skills specification —
 * '' when it does not.
 *
 * The specification (https://agentskills.io/specification, fetched 2026-09-06)
 * requires 1-64 characters of `a-z`, `0-9` and `-`, no leading, trailing or
 * doubled hyphen, and equality with the parent directory name. This states the
 * departure rather than rejecting the skill: the file is still readable and
 * still installable, and a repository we do not own is not ours to refuse.
 */
export function skillNameWarning(name: string, dirName: string): string {
  // Nothing declared is nothing to warn about — an unread entry keeps its
  // directory name, which is not a claim about the skill's own frontmatter.
  if (name === '') return ''
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return `Its name is ${name.length} characters; the Agent Skills specification allows ${SKILL_NAME_MAX_LENGTH}.`
  }
  if (![...name].every(isSpecNameCharacter)) {
    return `Its name “${name}” uses characters the Agent Skills specification does not allow — lowercase letters, numbers and hyphens only.`
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    return `Its name “${name}” starts or ends with a hyphen, which the Agent Skills specification does not allow.`
  }
  if (name.includes('--')) {
    return `Its name “${name}” has a doubled hyphen, which the Agent Skills specification does not allow.`
  }
  if (dirName !== '' && name !== dirName) {
    return `Its name “${name}” is not its directory name “${dirName}”, which the Agent Skills specification requires.`
  }
  return ''
}

/** The three bytes a Windows editor writes before the first character. */
function stripByteOrderMark(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** Directory name a skill installs under — the last segment of its id. */
export function skillDirName(skillId: string): string {
  const segments = skillId.split('/').filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : ''
}

/** Up to two uppercase letters for the source rail badge. */
export function skillSourceMonogram(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}
