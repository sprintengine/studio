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
//
// The manifest is read for everything it states, not just the words on a row
// (official-plugins ruling, 2026-09-06): `lspServers` is a component kind of
// its own — twelve of the official marketplace's plugins are that declaration
// and nothing else — and `strict`, `tags`, `keywords` and the top-level
// `renames` all ride the scan, because a field this file drops is a field no
// surface can ever show.
//
// A linked entry is FOLLOWED rather than left as a shell (linked-plugins
// ruling, 2026-09-06): `followLinkedPlugins` reads each distinct repository
// once at the commit the marketplace pinned. It is a second stage rather than
// part of `scanPluginTree` because it reads other repositories — a different
// reader, a different budget, and a pass that may legitimately stop half way
// and be finished by the next scan.

import { isMarketplaceSourceHostAllowed } from '../../shared/marketplace/source-policy'
import {
  emptyPluginComponents,
  type PluginReadState,
  type ScannedLspServer,
  type ScannedMcpServer,
  type ScannedPlugin,
  type ScannedPluginComponents,
  type ScannedPluginHook,
  type ScannedPluginOrigin,
  type ScannedSkill,
  type SourceShape,
} from '../../shared/skills'
import { scanSkillTree, type SkillTreeEntry } from './scan'

export const CLAUDE_PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json'
export const CLAUDE_MARKETPLACE_MANIFEST_PATH = '.claude-plugin/marketplace.json'
const MCP_CONFIG_FILE = '.mcp.json'
const HOOKS_FILE = 'hooks/hooks.json'
const MCP_REGISTRY_MANIFEST = 'server.json'

/**
 * How many in-tree plugins get their manifests read; beyond it they list by
 * directory name.
 *
 * Raised from 300 to 1000 by the official-plugins ruling (2026-09-06).
 * `anthropics/claude-plugins-official` lists 292 plugins at 85cce03 and gains
 * entries every week, so 300 was roughly one quarter's growth from becoming a
 * marketplace that quietly stops describing its last few plugins. The number is
 * not a size limit — a repository too large to scan is refused by the tree cap
 * (`DEFAULT_SKILL_MAX_TREE_ENTRIES`) long before this — it bounds the FILE
 * READS one scan makes: three small files per in-tree plugin, eight at a time,
 * from raw.githubusercontent.com. 1000 is over three times what the largest
 * marketplace in the wild holds and still a bounded scan.
 *
 * Only plugins that are actually read spend from it: a linked entry's bytes
 * live in another repository and are not fetched until it is opened, so 238
 * linked entries used to push the in-tree plugins listed after them past a
 * budget they had not spent a request from.
 */
export const MAX_SCANNED_PLUGINS = 1000
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
  /** The marketplace's `renames`, old name → the name it lists now. */
  pluginRenames: Record<string, string>
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
        plans.push({ entry, dir: entry.source.path, listedSkills: entry.skills, readIndex: -1 })
      } else {
        plans.push({ entry, dir: null, listedSkills: entry.skills, readIndex: -1 })
      }
    }
  }
  for (const dir of pluginDirs) {
    if (claimedDirs.has(dir)) continue
    plans.push({ entry: null, dir, listedSkills: [], readIndex: -1 })
  }
  // The read budget is spent by the plans that read (see MAX_SCANNED_PLUGINS).
  let budget = 0
  for (const plan of plans) {
    if (plan.dir !== null) plan.readIndex = budget++
  }

  const plugins: ScannedPlugin[] = new Array(plans.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, plans.length) }, async () => {
    while (cursor < plans.length) {
      const index = cursor
      cursor += 1
      plugins[index] = await realisePlan(plans[index], input, blobs)
    }
  })
  await Promise.all(workers)

  const declared = plugins.flatMap((plugin) => plugin.components.mcpServers)
  // A root `.mcp.json` or MCP-registry `server.json` outside any plugin: the
  // repository *is* a server (or ships one) without being a plugin.
  const rootIsPlugin = pluginDirs.includes('')
  const rootServers = rootIsPlugin ? [] : await readRootServers(blobs, input.readFile)
  const mcpServers = dedupeScannedMcpServers([...declared, ...rootServers])

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
    pluginRenames: renamesOfDepartedNames(marketplace?.renames ?? {}, plugins),
  }
}

/**
 * The renames that actually name a plugin that is GONE.
 *
 * A manifest may keep a rename whose old name it still lists — the official
 * marketplace's `renames` is a running log, not a diff of this revision. Both
 * names being live makes the entry a lie for lookup purposes: the old name is
 * a plugin in its own right, and treating it as an alias of the new one lets
 * two rows resolve to one install receipt, where uninstalling either would
 * delete the other's. A name the listing still holds keeps itself.
 */
function renamesOfDepartedNames(
  renames: Readonly<Record<string, string>>,
  plugins: readonly ScannedPlugin[]
): Record<string, string> {
  const listed = new Set(plugins.map((plugin) => plugin.id))
  const kept: Record<string, string> = {}
  for (const [was, now] of Object.entries(renames)) {
    if (!listed.has(was)) kept[was] = now
  }
  return kept
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
}): Promise<PluginComponentRead> {
  const blobs = new Set(
    options.entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path)
  )
  return readComponents(options.dir, blobs, options.skills, options.readFile, options.listedSkills ?? [], null)
}

// ── Following linked plugins ────────────────────────────────────────────────
//
// 238 of `anthropics/claude-plugins-official`'s 291 entries live in another
// repository, and until the linked-plugins ruling (2026-09-06) every one of
// them was a row that said nothing about what it installs. They are read here.
//
// The unit of work is a REPOSITORY AT A COMMIT, not a plugin: the 238 entries
// resolve to 220 distinct `repo@sha` pairs, several of them shared by two or
// three plugins in different subdirectories, and one tree listing answers for
// all of them at once.

/**
 * Repository trees one scan will fetch to follow linked plugins, WITH a token.
 *
 * The expensive request is the tree listing: it goes to api.github.com, which
 * is what GitHub's 5,000-an-hour authenticated limit counts. (The two or three
 * small files each followed plugin then reads come from
 * raw.githubusercontent.com, which that limit does not govern.) 250 covers the
 * official marketplace's 220 distinct pinned repositories in a single pass with
 * headroom for its growth, and spends 5% of an hour's authenticated budget —
 * bounded, and enough that "a full scan with a token" really is full.
 */
export const MAX_LINKED_REPOSITORY_READS = 250

/**
 * …and WITHOUT one, where GitHub allows 60 API requests an hour for the whole
 * machine — a budget the app's other GitHub work also draws on, and which the
 * source's own scan has already spent three of before this stage starts.
 *
 * 20 leaves most of the hour for everything else and, crucially, makes the scan
 * COMPLETE rather than die on request 57 with the listing half written. The
 * pass is resumable: everything it reads is cached against its pinned sha, so
 * the next Sync starts where this one stopped. Twelve syncs would cover the
 * official marketplace, which is the honest cost of no token — and why the head
 * line says so and offers the one setting that fixes it.
 */
export const MAX_LINKED_REPOSITORY_READS_ANONYMOUS = 20

/**
 * Repositories read at once. Each unit is one tree listing followed by up to
 * three small file reads, run in series, so this is also the ceiling on open
 * sockets — twenty, against GitHub's documented hundred.
 *
 * The number is latency, not budget: the same 220 repositories cost the same
 * 220 requests at any width, and this scan is what a person waits through the
 * first time they open the Plugins tab. Twenty read the live marketplace's 220
 * repositories in under four seconds on a warm link on 2026-09-06 (and in half
 * a minute on a bad one — the variance is the network, not the width), with no
 * secondary rate limit. Nothing wider was tried: the seconds left are not worth
 * crowding a limit whose penalty lands on the whole app's GitHub use.
 */
const LINKED_REPOSITORY_CONCURRENCY = 20

/**
 * Why a linked repository could not be read, in the three flavours that lead
 * somewhere different.
 *
 * `rate-limited` and `offline` are facts about this minute rather than about
 * the repository, so either one stops the whole pass — every request after it
 * would fail the same way — and leaves the plugins it did not reach PENDING, to
 * be read by the next scan. `unreadable` is a fact about the repository: a
 * commit that is gone, a repository that went private. That one fails its own
 * group and the pass carries on.
 */
export class LinkedPluginReadError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate-limited' | 'offline' | 'unreadable'
  ) {
    super(message)
    this.name = 'LinkedPluginReadError'
  }
}

/**
 * Another repository, read at a commit. One implementation fetches GitHub; the
 * unit suite's answers from recorded bytes, so the batching, the cache and the
 * partial states are all tested with no network at all.
 */
export type LinkedPluginRepoReader = {
  /** The commit a ref names, for the rare entry a marketplace did not pin. */
  resolveCommit: (repo: string, ref: string) => Promise<string>
  /** The whole tree listing at that commit — the one expensive request. */
  readTree: (repo: string, sha: string) => Promise<readonly SkillTreeEntry[]>
  /** One file at that commit; null when it is missing. */
  readFile: (repo: string, sha: string, path: string) => Promise<string | null>
}

export type FollowLinkedPluginsInput = {
  plugins: readonly ScannedPlugin[]
  reader: LinkedPluginRepoReader
  /** How many repository trees this pass may fetch. */
  budget: number
  /**
   * The plugins a previous scan of this source left behind. A linked plugin
   * whose pinned sha has not moved is taken from here and costs no request at
   * all, which is what makes a re-scan read only what moved.
   */
  cached?: readonly ScannedPlugin[]
  /** The source's marketplace manifest, for the `skills` an entry names itself. */
  marketplaceManifest?: string | null
  /** Hosts the allowlist has been widened to, for an honest refusal. */
  extraHosts?: readonly string[]
}

export type FollowLinkedPluginsResult = {
  plugins: ScannedPlugin[]
  /** Repository trees actually fetched — what this pass spent. */
  repositoriesRead: number
  /** Servers the followed plugins declare, for the source's own server list. */
  mcpServers: ScannedMcpServer[]
}

/**
 * Read every linked plugin's own repository, within a budget.
 *
 * The order of business, and why each step is where it is:
 *
 *  1. A plugin whose host this app cannot read is settled without a request —
 *     saying so is free, and spending a repository of budget to prove it again
 *     every scan would be the storm this budget exists to prevent.
 *  2. A plugin whose pinned sha matches a cached read is taken from the cache.
 *     Pinned means the bytes cannot have moved, so re-reading them would be a
 *     request that can only return what is already in hand.
 *  3. What is left is grouped by `repo@sha` and the groups are ordered: ones
 *     holding a plugin nobody has read go first, ones only retrying a previous
 *     failure last. A repository that 404s must never crowd out one that would
 *     have answered.
 *  4. Groups past the budget are `pending: 'budget'` — stated, not silent.
 *  5. The first reply that is about the minute rather than the repository — a
 *     rate limit, or no network at all — stops the pass. Every request after it
 *     would fail the same way, and the plugins it would have covered are marked
 *     `pending` rather than `unreadable`: a limit resets, a connection returns.
 *
 * Skill entry documents are deliberately NOT read here. A plugin's components
 * are its skills, commands, agents, hooks and servers, and the tree listing
 * proves all of those by name; a description costs one more request per skill
 * across an unbounded second population, and it arrives when the plugin is
 * opened and its one repository is read properly (`scanLinkedPlugin`).
 */
export async function followLinkedPlugins(
  input: FollowLinkedPluginsInput
): Promise<FollowLinkedPluginsResult> {
  const listedSkills = listedSkillsByPlugin(input.marketplaceManifest ?? null)
  const cached = new Map<string, ScannedPlugin>()
  for (const plugin of input.cached ?? []) cached.set(plugin.id, plugin)

  const plugins = [...input.plugins]
  const groups = new Map<string, { sha: string; ref: string; repo: string; indexes: number[]; retryOnly: boolean }>()

  for (let index = 0; index < plugins.length; index += 1) {
    const plugin = plugins[index]
    const origin = plugin.origin
    if (origin.kind !== 'linked') continue

    const refusal = hostRefusal(origin, input.extraHosts ?? [])
    if (refusal) {
      plugins[index] = markLinked(plugin, { status: 'unreadable', message: refusal })
      continue
    }

    const hit = cached.get(plugin.id)
    // The whole address, not just the commit: a marketplace that moves a
    // plugin's subdirectory without moving the commit would otherwise be served
    // components from a directory that no longer exists (linked-plugins
    // review, 2026-09-06).
    if (hit && sameLinkedBytes(hit, origin) && hit.componentsKnown) {
      plugins[index] = {
        ...plugin,
        // Everything the linked repository's own manifest filled in, carried
        // through. All 238 of the official marketplace's linked entries state
        // no version and 70 state no author, so a reuse that kept only the
        // entry's fields blanked the version on 238 rows at the second Sync.
        version: plugin.version || hit.version,
        description: plugin.description || hit.description,
        author: plugin.author || hit.author,
        homepage: plugin.homepage || hit.homepage,
        componentsKnown: true,
        components: hit.components,
        readState: hit.readState?.status === 'read' ? { status: 'read' } : { status: 'listed' },
        readCommit: hit.readCommit,
      }
      continue
    }

    // An entry the marketplace did not pin has no sha to group by, so its ref
    // is the key: two entries on the same ref still share one resolve and one
    // tree, and one on another ref is honestly a second repository to read.
    const key = origin.sha !== '' ? `${origin.repo}@${origin.sha}` : `${origin.repo}#${origin.ref}`
    const group = groups.get(key)
    // A group is demoted when every plugin in it already has a verdict this
    // pass cannot improve on: one that failed for good, and — the loop the
    // review found — one whose reply halted the last pass. Left promoted, a
    // repository that always answers 403 is picked in the first batch of every
    // scan and halts it again, so the follow never finishes.
    const spent = hit?.readState?.status === 'unreadable'
      || (hit?.readState?.status === 'pending' && hit.readState.blocked === true)
    if (group) {
      group.indexes.push(index)
      group.retryOnly = group.retryOnly && spent
    } else {
      groups.set(key, { sha: origin.sha, ref: origin.ref, repo: origin.repo, indexes: [index], retryOnly: spent })
    }
  }

  // Never-read repositories first; ones with nothing new to gain from a retry last.
  const ordered = [...groups.values()].sort((a, b) => Number(a.retryOnly) - Number(b.retryOnly))
  const affordable = ordered.slice(0, Math.max(0, input.budget))
  for (const group of ordered.slice(Math.max(0, input.budget))) {
    for (const index of group.indexes) {
      plugins[index] = markLinked(plugins[index], { status: 'pending', reason: 'budget' })
    }
  }

  // Set by the first reply that says the problem is the minute, not the
  // repository; every group after it is marked with the same reason and asks
  // for nothing.
  let halted: 'rate-limited' | 'offline' | null = null
  let repositoriesRead = 0
  // API requests this pass has committed to. One per tree, plus the resolves an
  // unpinned entry costs before its tree can be asked for.
  let spent = affordable.length
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(LINKED_REPOSITORY_CONCURRENCY, affordable.length) },
    async () => {
      while (cursor < affordable.length) {
        const group = affordable[cursor]
        cursor += 1
        if (halted) {
          for (const index of group.indexes) {
            plugins[index] = markLinked(plugins[index], { status: 'pending', reason: halted })
          }
          continue
        }
        try {
          // Resolving a ref is one API request of its own — two when the entry
          // names no ref and the default branch has to be looked up first — so
          // it is charged against the budget before it is spent, not after
          // (linked-plugins review, 2026-09-06). Twenty unpinned entries were
          // otherwise able to spend the whole unauthenticated hour that a
          // budget of twenty exists to protect.
          if (group.sha === '') {
            const cost = group.ref === '' ? 2 : 1
            if (spent + cost > input.budget) {
              for (const index of group.indexes) {
                plugins[index] = markLinked(plugins[index], { status: 'pending', reason: 'budget' })
              }
              continue
            }
            spent += cost
          }
          const sha = group.sha || (await input.reader.resolveCommit(group.repo, group.ref))
          const entries = await input.reader.readTree(group.repo, sha)
          repositoriesRead += 1
          const tree = scanSkillTree({ entries: [...entries], commitSha: sha })
          for (const index of group.indexes) {
            plugins[index] = await readLinkedPlugin({
              plugin: plugins[index],
              sha,
              entries,
              skills: tree.skills,
              listedSkills: listedSkills.get(plugins[index].id) ?? [],
              readFile: (path) => input.reader.readFile(group.repo, sha, path),
            })
          }
        } catch (error) {
          const kind = error instanceof LinkedPluginReadError ? error.kind : 'unreadable'
          if (kind !== 'unreadable') halted = kind
          const state: PluginReadState =
            kind === 'unreadable'
              ? { status: 'unreadable', message: describeLinkedFailure(group, error) }
              // `blocked`, because THIS is the repository whose reply stopped
              // the pass. The next pass ranks it behind everything else rather
              // than picking it first and stopping on it again.
              : { status: 'pending', reason: kind, blocked: true }
          for (const index of group.indexes) plugins[index] = markLinked(plugins[index], state)
        }
      }
    }
  )
  await Promise.all(workers)

  const followed = plugins.filter(
    (plugin) => plugin.origin.kind === 'linked' && plugin.componentsKnown
  )
  return {
    plugins,
    repositoriesRead,
    mcpServers: dedupeScannedMcpServers(followed.flatMap((plugin) => plugin.components.mcpServers)),
  }
}

/** The budget for one pass: a token is the difference between 20 and 250. */
export function linkedRepositoryBudget(token: string | undefined): number {
  return token && token.trim() !== '' ? MAX_LINKED_REPOSITORY_READS : MAX_LINKED_REPOSITORY_READS_ANONYMOUS
}

/**
 * Whether a cached plugin is the same BYTES as the entry now names.
 *
 * The commit alone is not the address: a marketplace can move a plugin from
 * one subdirectory to another without moving the commit, and it can point an
 * entry at a different repository entirely. An unpinned entry is never a hit —
 * "no pin" means "whatever the ref points at today", which is not something a
 * cache can answer (linked-plugins review, 2026-09-06).
 */
function sameLinkedBytes(
  cached: ScannedPlugin,
  origin: Extract<ScannedPluginOrigin, { kind: 'linked' }>
): boolean {
  if (origin.sha === '' || cached.origin.kind !== 'linked') return false
  return (
    cached.origin.sha === origin.sha
    && cached.origin.repo === origin.repo
    && cached.origin.path === origin.path
  )
}

async function readLinkedPlugin(options: {
  plugin: ScannedPlugin
  sha: string
  entries: readonly SkillTreeEntry[]
  skills: readonly ScannedSkill[]
  listedSkills: readonly string[]
  readFile: PluginFileReader
}): Promise<ScannedPlugin> {
  const plugin = options.plugin
  const dir = plugin.origin.kind === 'linked' ? plugin.origin.path : ''
  const read = await readPluginComponents({
    dir,
    entries: options.entries,
    skills: options.skills,
    readFile: options.readFile,
    listedSkills: options.listedSkills,
  })
  return {
    ...plugin,
    // The marketplace entry's words outrank the plugin's own manifest, exactly
    // as they do for an in-tree plugin: it is the curated listing. The manifest
    // fills only what the entry left blank.
    version: plugin.version || read.manifest?.version || '',
    description: plugin.description || read.manifest?.description || '',
    author: plugin.author || read.manifest?.author || '',
    homepage: plugin.homepage || read.manifest?.homepage || '',
    // `origin.sha` stays what the MARKETPLACE pinned, '' included. The commit
    // this read used goes beside it: writing it into the origin made an entry
    // the publisher left floating read as pinned, and silently moved every
    // later install onto whatever commit a scan happened to see.
    readCommit: options.sha,
    // A read that lost a file the tree listed is not a read plugin. Saying so
    // is what keeps the install gate honest: the hooks file is the one most
    // worth losing to a throttled request, and a plugin cached with none is a
    // plugin installed with nobody shown the commands it runs.
    componentsKnown: read.unreadFiles.length === 0,
    readState:
      read.unreadFiles.length > 0
        ? { status: 'partial', unread: read.unreadFiles }
        // `listed`, not `read`: the components are real, but no skill's entry
        // document was fetched, so the descriptions arrive when it is opened.
        : { status: 'listed' },
    components: {
      ...read.components,
      mcpServers: read.components.mcpServers.map((server) => ({ ...server, declaredBy: plugin.id })),
    },
  }
}

/** A plugin that was not read keeps its empty components and gains the reason. */
function markLinked(plugin: ScannedPlugin, readState: PluginReadState): ScannedPlugin {
  return { ...plugin, componentsKnown: false, components: emptyPluginComponents(), readState }
}

/**
 * Why this app will not even try a repository, or null when it will.
 *
 * `repo` is '' for anything `githubRepoFromUrl` could not place on github.com,
 * which is the only host these reads speak: the tree listing is the GitHub API.
 * The allowlist (src/shared/marketplace/source-policy.ts) is consulted so the
 * two refusals read differently — a host nobody allowed and a host that is
 * allowed to serve bundles but cannot serve a git tree are not the same fact,
 * and a person shown one message for both would go looking for the wrong fix.
 */
function hostRefusal(
  origin: Extract<ScannedPluginOrigin, { kind: 'linked' }>,
  extraHosts: readonly string[]
): string | null {
  if (origin.repo !== '') return null
  const host = hostnameOf(origin.url)
  if (host === '') return 'Names no repository this app can read.'
  return isMarketplaceSourceHostAllowed(host, extraHosts)
    ? `Hosted on ${host}; plugin repositories are read from github.com only.`
    : `Hosted on ${host}, which is not on this app's allowlist.`
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function describeLinkedFailure(group: { repo: string; sha: string }, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const at = group.sha === '' ? group.repo : `${group.repo} at ${group.sha.slice(0, 7)}`
  return `${at} could not be read: ${detail}`
}

/**
 * Each entry's own `skills` list, by plugin name. Three of the official
 * marketplace's linked entries name their skills explicitly instead of
 * shipping a `skills/` directory, and a follow that ignored the list would
 * report those three as shipping nothing.
 */
function listedSkillsByPlugin(raw: string | null): Map<string, readonly string[]> {
  const listed = new Map<string, readonly string[]>()
  const marketplace = parseMarketplaceManifest(raw)
  for (const entry of marketplace?.plugins ?? []) {
    if (entry.skills.length > 0) listed.set(entry.name, entry.skills)
  }
  return listed
}

// ── Plans ───────────────────────────────────────────────────────────────────

type PluginPlan = {
  entry: MarketplaceEntry | null
  /** The in-tree directory, or null for a linked entry. */
  dir: string | null
  listedSkills: readonly string[]
  /** Position in the read budget; -1 for a plan that reads nothing. */
  readIndex: number
}

async function realisePlan(
  plan: PluginPlan,
  input: PluginTreeScanInput,
  blobs: ReadonlySet<string>
): Promise<ScannedPlugin> {
  const entry = plan.entry
  if (plan.dir === null && entry && entry.source.kind === 'linked') {
    // Not read now: its bytes live in another repository. The entry's own
    // words are all that is known until it is opened — including the language
    // servers it declares here, which are the marketplace's statement rather
    // than anything inside that repository.
    return {
      id: entry.name,
      name: entry.displayName || entry.name,
      description: entry.description,
      version: entry.version,
      category: entry.category,
      author: entry.author,
      homepage: entry.homepage,
      strict: entry.strict,
      tags: entry.tags,
      keywords: entry.keywords,
      origin: entry.source,
      componentsKnown: false,
      components: emptyPluginComponents(),
    }
  }
  const dir = plan.dir ?? ''
  const overBudget = plan.readIndex >= MAX_SCANNED_PLUGINS
  const { manifest, components, unreadFiles } = overBudget
    ? { manifest: null, components: emptyPluginComponents(), unreadFiles: [] as string[] }
    : await readComponents(dir, blobs, input.skills, input.readFile, plan.listedSkills, entry?.name ?? null)
  const dirName = dir === '' ? '' : dir.slice(dir.lastIndexOf('/') + 1)
  const id = entry?.name || manifest?.name || dirName || 'plugin'
  // A marketplace entry's language servers and the plugin manifest's are one
  // list: the twelve `*-lsp` plugins declare theirs in the entry alone, and a
  // plugin that ships a manifest may declare its own.
  const lspServers = dedupeLspServers([
    ...(entry?.lspServers ?? []).map((server) => ({ ...server, declaredBy: id })),
    ...components.lspServers.map((server) => ({ ...server, declaredBy: id })),
  ])
  return {
    id,
    name: entry?.displayName || manifest?.name || entry?.name || dirName || 'plugin',
    description: entry?.description || manifest?.description || '',
    version: manifest?.version || entry?.version || '',
    category: entry?.category || '',
    author: entry?.author || manifest?.author || '',
    homepage: entry?.homepage || manifest?.homepage || '',
    strict: entry?.strict ?? true,
    tags: entry?.tags ?? [],
    keywords: entry?.keywords ?? [],
    origin: { kind: 'in-tree', path: dir },
    // An in-tree plugin is read from the same repository as the rest of the
    // scan, but a raw read still fails, and it fails the same way: a plugin
    // whose hooks file was lost is not a plugin with no hooks (linked-plugins
    // review, 2026-09-06).
    componentsKnown: !overBudget && unreadFiles.length === 0,
    ...(overBudget
      ? {}
      : {
          readState:
            unreadFiles.length > 0
              ? ({ status: 'partial', unread: unreadFiles } as const)
              : ({ status: 'read' } as const),
        }),
    components: {
      ...components,
      mcpServers: components.mcpServers.map((server) => ({ ...server, declaredBy: id })),
      lspServers,
    },
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

/**
 * What one plugin directory holds, and what could not be read of it.
 *
 * `unreadFiles` is the load-bearing half (linked-plugins review, 2026-09-06).
 * The scan asks for a path only when the TREE LISTING said it exists, so a
 * null from the reader is a fetch that failed, never a file that is not there
 * — and the two used to be the same value. A `hooks/hooks.json` lost to
 * throttling became a plugin cached as fully read with no hooks, which is
 * exactly the plugin the install gate waves through without showing anybody
 * the commands it is about to let Claude Code run.
 */
export type PluginComponentRead = {
  manifest: PluginManifest | null
  components: ScannedPluginComponents
  /** Repo-relative paths the tree listed that this read could not fetch. */
  unreadFiles: string[]
}

async function readComponents(
  dir: string,
  blobs: ReadonlySet<string>,
  skills: readonly ScannedSkill[],
  readFile: PluginFileReader,
  listedSkills: readonly string[],
  declaredBy: string | null
): Promise<PluginComponentRead> {
  const under = (relative: string): string => (dir === '' ? relative : `${dir}/${relative}`)
  const unreadFiles: string[] = []
  // The tree listed it, so a null is a failure. Anything the tree did NOT list
  // is simply absent and costs no request at all.
  const readListed = async (path: string): Promise<string | null> => {
    if (!blobs.has(path)) return null
    const raw = await readFile(path)
    if (raw === null) unreadFiles.push(path)
    return raw
  }
  const manifestPath = under(CLAUDE_PLUGIN_MANIFEST_PATH)
  const rawManifest = await readListed(manifestPath)
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

  const mcpPath = under(MCP_CONFIG_FILE)
  const [rawHooks, rawMcp] = await Promise.all([readListed(under(HOOKS_FILE)), readListed(mcpPath)])
  const hooks = readHooks(rawHooks, parsedManifest?.inlineHooks ?? null)
  const mcpServers = readMcpServers(rawMcp, mcpPath, parsedManifest?.inlineMcpServers ?? null, declaredBy ?? '')
  const lspServers = parseLspServers(parsedManifest?.inlineLspServers ?? null, manifestPath, declaredBy ?? '')

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
    components: { skills: pluginSkills, commands, agents, hooks, mcpServers, lspServers, missingSkills },
    unreadFiles,
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
  inlineLspServers: unknown
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
    inlineLspServers: isObject(parsed.lspServers) ? parsed.lspServers : null,
  }
}

// ── Language servers ────────────────────────────────────────────────────────

/**
 * `lspServers`: a map of id → `{ command, args, extensionToLanguage,
 * startupTimeout }`, declared by a marketplace entry or a plugin manifest. A
 * declaration naming no command is not a language server — nothing could be
 * started from it — and is dropped rather than listed as one that will never
 * run. The id is checked the same way an MCP server's is: it names a process
 * this app may one day launch, and `../` is not a name.
 */
export function parseLspServers(value: unknown, declaredIn: string, declaredBy: string): ScannedLspServer[] {
  if (!isObject(value)) return []
  const servers: ScannedLspServer[] = []
  for (const [id, raw] of Object.entries(value)) {
    if (!isObject(raw) || !/^[A-Za-z0-9._-]+$/.test(id)) continue
    const command = stringOf(raw.command).trim()
    if (command === '') continue
    const timeout = typeof raw.startupTimeout === 'number' && Number.isFinite(raw.startupTimeout)
      ? raw.startupTimeout
      : 0
    servers.push({
      id,
      command,
      args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : [],
      extensionToLanguage: stringRecord(raw.extensionToLanguage),
      startupTimeout: timeout,
      declaredIn,
      declaredBy,
    })
  }
  return servers
}

function dedupeLspServers(servers: readonly ScannedLspServer[]): ScannedLspServer[] {
  const seen = new Set<string>()
  const out: ScannedLspServer[] = []
  for (const server of servers) {
    if (seen.has(server.id)) continue
    seen.add(server.id)
    out.push(server)
  }
  return out
}

// ── Hooks ───────────────────────────────────────────────────────────────────

function readHooks(raw: string | null, inline: unknown): ScannedPluginHook[] {
  const hooks: ScannedPluginHook[] = []
  if (inline) hooks.push(...parseHooks(inline))
  const parsed = parseJsonObject(raw)
  if (parsed) hooks.push(...parseHooks(parsed))
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

function readMcpServers(
  raw: string | null,
  path: string,
  inline: unknown,
  declaredBy: string
): ScannedMcpServer[] {
  const servers: ScannedMcpServer[] = []
  if (inline) servers.push(...parseMcpServers(inline, `${declaredBy || 'plugin'}/${CLAUDE_PLUGIN_MANIFEST_PATH}`, declaredBy))
  const parsed = parseJsonObject(raw)
  if (parsed) servers.push(...parseMcpServers(parsed, path, declaredBy))
  return dedupeScannedMcpServers(servers)
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

/**
 * One server per `declaredBy` + id. The plugin is part of the key on purpose:
 * two plugins may each ship a server called `context7`, and collapsing them
 * would attribute one plugin's server to the other.
 */
export function dedupeScannedMcpServers(servers: readonly ScannedMcpServer[]): ScannedMcpServer[] {
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
  /** Absent means true — the marketplace schema's own default. */
  strict: boolean
  tags: string[]
  keywords: string[]
  lspServers: ScannedLspServer[]
}

type MarketplaceManifest = {
  name: string
  plugins: MarketplaceEntry[]
  /** Old plugin name → the name this marketplace lists it under now. */
  renames: Record<string, string>
}

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
      strict: item.strict !== false,
      tags: stringList(item.tags),
      keywords: stringList(item.keywords),
      lspServers: parseLspServers(item.lspServers, CLAUDE_MARKETPLACE_MANIFEST_PATH, name),
    })
  }
  return { name: stringOf(parsed.name).trim(), plugins, renames: parseRenames(parsed.renames) }
}

/**
 * The manifest's top-level `renames`. Kept verbatim, including a name it maps
 * to a plugin the listing no longer holds: the map is the marketplace's record
 * of what a plugin used to be called, and an entry it cannot resolve today may
 * resolve after the next Sync. A self-map is dropped — it would make a lookup
 * chase its own tail for nothing.
 */
function parseRenames(value: unknown): Record<string, string> {
  if (!isObject(value)) return {}
  const renames: Record<string, string> = {}
  for (const [was, now] of Object.entries(value)) {
    const to = stringOf(now).trim()
    if (was.trim() === '' || to === '' || was === to) continue
    renames[was] = to
  }
  return renames
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
  // The same check the in-tree branch makes. Today only `blobs.has()` against a
  // tree we fetched stops a traversal from escaping the plugin's directory,
  // which is one refactor away from not stopping it (linked-plugins review,
  // 2026-09-06).
  if (path.split('/').some((segment) => segment === '..')) return null
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
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
