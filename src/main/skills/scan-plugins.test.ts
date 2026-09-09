// The plugin scan rule, against the recorded anthropics/claude-plugins-official
// tree at 85cce03 and the bytes of a handful of its files. No network: the
// reader answers from the fixture and says "missing" for everything else,
// which is exactly what a plugin whose manifest could not be read gets.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describePluginComponents,
  findScannedPlugin,
  pluginIconGlyph,
  pluginLogoUrl,
  describeUnreadPlugin,
  linkedPluginShortfall,
  pluginAliases,
  scanPluginRenames,
  scanPlugins,
  scanShape,
  summariseLinkedPlugins,
  unreadPluginChip,
  unreadPluginReason,
  type LinkedPluginSummary,
  type ScanResult,
  type ScannedPlugin,
} from '../../shared/skills'
import { scanSkillTree, type SkillTreeEntry } from './scan'
import {
  CLAUDE_MARKETPLACE_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  followLinkedPlugins,
  githubRepoFromUrl,
  linkedRepositoryBudget,
  LinkedPluginReadError,
  MAX_LINKED_REPOSITORY_READS,
  MAX_LINKED_REPOSITORY_READS_ANONYMOUS,
  MAX_SCANNED_PLUGINS,
  parseHooks,
  parseLspServers,
  parseMarketplaceManifest,
  parseMcpRegistryManifest,
  parseMcpServers,
  readPluginComponents,
  scanPluginTree,
  type LinkedPluginRepoReader,
} from './scan-plugins'

const FIXTURES = join(process.cwd(), 'src', 'main', 'skills', '__fixtures__')

type RecordedTree = { repo: string; commitSha: string; truncated: boolean; tree: SkillTreeEntry[] }
type RecordedFiles = { repo: string; commitSha: string; files: Record<string, string> }

function recorded(name: string): RecordedTree {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.tree.json`), 'utf8')) as RecordedTree
}

function recordedFiles(name: string): Map<string, string> {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, `${name}.files.json`), 'utf8')) as RecordedFiles
  return new Map(Object.entries(parsed.files))
}

function manifest(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.marketplace.json`), 'utf8')
}

async function pluginArtworkFields(): Promise<void> {
  // `icon` and `logo` on a marketplace entry: not in the documented field
  // table, written by marketplaces anyway, and so read leniently and validated
  // strictly. The fixture is one entry per shape a publisher can write.
  const scan = await scanPluginTree({
    entries: [],
    skills: [],
    marketplaceManifest: manifest('plugin-artwork'),
    readFile: async () => null,
  })
  const byId = new Map(scan.plugins.map((plugin) => [plugin.id, plugin]))
  assert.equal(byId.size, 13, 'every entry lists, whatever its artwork turned out to be')

  assert.equal(byId.get('glyph')?.icon, '🦀')
  assert.equal(byId.get('joined-glyph')?.icon, '👩‍💻', 'a zero-width joiner is not a control character')
  assert.equal(byId.get('lettered-glyph')?.icon, 'AI', 'a glyph is short text, not only an emoji')
  assert.equal(byId.get('logo')?.logo, 'https://cdn.example.com/logo.png')
  assert.equal(byId.get('both')?.icon, '⚙️')
  assert.equal(byId.get('both')?.logo, 'https://cdn.example.com/both.png', 'both are kept; the ladder is the renderer’s')

  for (const id of ['wordy-icon', 'path-icon', 'data-uri-icon', 'typed-wrong']) {
    assert.equal(byId.get(id)?.icon, undefined, `${id} declares no glyph this app may print`)
  }
  for (const id of ['http-logo', 'data-logo', 'nonsense-logo', 'typed-wrong']) {
    assert.equal(byId.get(id)?.logo, undefined, `${id} declares no https picture`)
  }
  const plain = byId.get('plain')
  assert.equal(plain?.icon, undefined)
  assert.equal(plain?.logo, undefined)
  assert.equal(
    Object.prototype.hasOwnProperty.call(plain, 'icon'),
    false,
    'the field is absent, not empty: a scan is cached to disk verbatim',
  )

  // A plugin's own manifest, which no schema documents either, fills what the
  // entry left blank — and never outranks it.
  const files = new Map([
    ['plugins/from-manifest/.claude-plugin/plugin.json', JSON.stringify({ name: 'from-manifest', icon: '📦', logo: 'https://cdn.example.com/m.png' })],
    ['plugins/entry-wins/.claude-plugin/plugin.json', JSON.stringify({ name: 'entry-wins', icon: '📦' })],
  ])
  const withManifests = await scanPluginTree({
    entries: [...files.keys()].map((path) => ({ path, mode: '100644', type: 'blob', sha: path, size: 1 })),
    skills: [],
    marketplaceManifest: JSON.stringify({
      name: 'm',
      plugins: [
        { name: 'from-manifest', source: './plugins/from-manifest' },
        { name: 'entry-wins', source: './plugins/entry-wins', icon: '🚀' },
      ],
    }),
    readFile: async (path) => files.get(path) ?? null,
  })
  const manifests = new Map(withManifests.plugins.map((plugin) => [plugin.id, plugin]))
  assert.equal(manifests.get('from-manifest')?.icon, '📦')
  assert.equal(manifests.get('from-manifest')?.logo, 'https://cdn.example.com/m.png')
  assert.equal(manifests.get('entry-wins')?.icon, '🚀', 'the curated listing outranks the plugin’s own manifest')

  // The validators on their own, at the edges the fixture cannot hold.
  assert.equal(pluginIconGlyph('  🦀  '), '🦀', 'surrounding space is not part of the glyph')
  assert.equal(pluginIconGlyph('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦', 'a family is seven code points, inside the limit')
  assert.equal(pluginIconGlyph('123456789'), '', 'nine code points is text, not a glyph')
  assert.equal(pluginIconGlyph('a\nb'), '', 'a line break is not a glyph')
  assert.equal(pluginIconGlyph(null), '')
  assert.equal(pluginIconGlyph(['🦀']), '')
  assert.equal(pluginLogoUrl('https://example.com/a.png?v=2'), 'https://example.com/a.png?v=2')
  assert.equal(pluginLogoUrl('HTTPS://example.com/a.png'), 'HTTPS://example.com/a.png', 'the scheme is not case sensitive')
  assert.equal(pluginLogoUrl('file:///etc/passwd'), '')
  assert.equal(pluginLogoUrl(''), '')
  assert.equal(pluginLogoUrl(7), '')
}

/**
 * A scan cached before either field existed carries neither, which is the same
 * absence as a plugin that declares neither — nothing may crash on it.
 */
function cachedScansPredatingPluginArtwork(): void {
  const cached = {
    skills: [],
    groups: [],
    groupingSignal: 'none',
    fileCount: 0,
    commitSha: 'abc1234',
    plugins: [
      {
        id: 'security-guidance',
        name: 'security-guidance',
        description: '',
        version: '2.0.7',
        category: '',
        author: 'Anthropic',
        homepage: '',
        origin: { kind: 'in-tree', path: 'plugins/security-guidance' },
        strict: true,
        tags: [],
        keywords: [],
        componentsKnown: true,
        components: { skills: [], commands: [], agents: [], hooks: [], mcpServers: [], lspServers: [], missingSkills: [] },
      },
    ],
  } as unknown as ScanResult
  const [plugin] = scanPlugins(cached)
  assert.equal(plugin.icon, undefined, 'an absent glyph reads as absent, not as an empty one')
  assert.equal(plugin.logo, undefined)
  assert.equal(describePluginComponents(plugin).length > 0, true, 'and the surface still describes it')
}

async function scanOfficial(): Promise<ScanResult> {
  const tree = recorded('claude-plugins-official')
  assert.equal(tree.truncated, false)
  const files = recordedFiles('claude-plugins-official')
  const marketplaceManifest = manifest('claude-plugins-official')
  const skills = scanSkillTree({ entries: tree.tree, commitSha: tree.commitSha, marketplaceManifest })
  const plugins = await scanPluginTree({
    entries: tree.tree,
    skills: skills.skills,
    marketplaceManifest,
    readFile: async (path) => files.get(path) ?? null,
  })
  return { ...skills, ...plugins }
}

async function officialMarketplace(): Promise<void> {
  const scan = await scanOfficial()
  assert.equal(scanShape(scan), 'claude-marketplace')
  assert.equal(scan.marketplaceName, 'claude-plugins-official')

  const plugins = scanPlugins(scan)
  // Every marketplace entry lists, in the marketplace's order, then the one
  // manifest directory the marketplace does not enumerate (example-plugin) —
  // a plugin that exists is a plugin. Nothing is invented for the ones hosted
  // elsewhere.
  assert.equal(plugins.length, 292)
  assert.equal(plugins[0].id, '42crunch-api-security-testing')
  assert.equal(plugins[291].id, 'example-plugin')
  const linked = plugins.filter((plugin) => plugin.origin.kind === 'linked')
  const inTree = plugins.filter((plugin) => plugin.origin.kind === 'in-tree')
  assert.equal(linked.length, 238)
  assert.equal(inTree.length, 54)
  assert.ok(linked.every((plugin) => plugin.componentsKnown === false))
  assert.ok(inTree.every((plugin) => plugin.componentsKnown === true))

  // A git-subdir entry keeps the repository, the directory and the pinned commit.
  const crunch = plugins[0]
  assert.deepEqual(crunch.origin, {
    kind: 'linked',
    repo: '42Crunch-AI/claude-plugins',
    ref: 'v1.5.5',
    sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
    path: 'plugins/api-security-testing',
    url: 'https://github.com/42Crunch-AI/claude-plugins.git',
  })
  assert.equal(crunch.author, '42Crunch')
  assert.equal(crunch.category, 'security')

  // A url entry is the whole repository at a commit.
  const adlc = plugins.find((plugin) => plugin.id === 'agentforce-adlc')
  assert.ok(adlc)
  assert.deepEqual(adlc.origin, {
    kind: 'linked',
    repo: 'SalesforceAIResearch/agentforce-adlc',
    ref: '',
    sha: 'd16d14ac7f817336e21bf9392cf51b6cac6194d8',
    path: '',
    url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
  })

  // An in-tree plugin whose manifest was read: version from the manifest,
  // hooks verbatim from hooks/hooks.json.
  const guidance = plugins.find((plugin) => plugin.id === 'security-guidance')
  assert.ok(guidance)
  assert.deepEqual(guidance.origin, { kind: 'in-tree', path: 'plugins/security-guidance' })
  assert.equal(guidance.version, '2.0.7')
  // The marketplace entry outranks the plugin manifest for the words a row
  // shows: it is the curated listing, and it names Anthropic here.
  assert.equal(guidance.author, 'Anthropic')
  assert.ok(guidance.components.hooks.length >= 3)
  assert.equal(guidance.components.hooks[0].event, 'SessionStart')
  assert.match(guidance.components.hooks[0].command, /sg-python\.sh/)
  assert.equal(guidance.components.mcpServers.length, 0)

  // An MCP plugin: the server, its transport, and the env var its header names.
  const context7 = plugins.find((plugin) => plugin.id === 'context7')
  assert.ok(context7)
  assert.equal(context7.components.mcpServers.length, 1)
  const server = context7.components.mcpServers[0]
  assert.equal(server.id, 'context7')
  assert.equal(server.transport, 'http')
  assert.equal(server.url, 'https://mcp.context7.com/mcp')
  assert.deepEqual(server.envVarNames, ['CONTEXT7_API_KEY'])
  assert.equal(server.declaredIn, 'external_plugins/context7/.mcp.json')
  assert.equal(server.declaredBy, 'context7')

  // The bare-map .mcp.json shape is a server too.
  const example = plugins.find((plugin) => plugin.id === 'example-plugin')
  assert.ok(example)
  assert.equal(example.components.mcpServers.length, 1)
  assert.equal(example.components.mcpServers[0].id, 'example-server')
  assert.deepEqual(example.components.commands, ['example-command'])
  assert.deepEqual(example.components.agents, [])
  assert.equal(example.components.skills.length, 2)

  // A skill plugin's skill is the scan's own skill object.
  const frontend = plugins.find((plugin) => plugin.id === 'frontend-design')
  assert.ok(frontend)
  assert.equal(frontend.components.skills.length, 1)
  assert.equal(frontend.components.skills[0].id, 'plugins/frontend-design/skills/frontend-design')
  assert.equal(frontend.components.skills[0].name, 'frontend-design')

  // A plugin whose manifest bytes were NOT recorded still lists, under the
  // entry's own words, with the components the tree alone can prove.
  const review = plugins.find((plugin) => plugin.id === 'code-review')
  assert.ok(review)
  assert.equal(review.componentsKnown, true)
  assert.ok(review.components.commands.length > 0)

  // A language server is a component kind of its own. The twelve `*-lsp`
  // plugins are the marketplace entry's `lspServers` and nothing else — their
  // directories hold a LICENSE and a README, no manifest at all — so a scan
  // that read only manifests listed them as plugins that ship nothing.
  const clangd = plugins.find((plugin) => plugin.id === 'clangd-lsp')
  assert.ok(clangd)
  assert.deepEqual(clangd.origin, { kind: 'in-tree', path: 'plugins/clangd-lsp' })
  assert.equal(clangd.componentsKnown, true)
  assert.equal(clangd.components.lspServers.length, 1)
  const lsp = clangd.components.lspServers[0]
  assert.equal(lsp.id, 'clangd')
  assert.equal(lsp.command, 'clangd')
  assert.deepEqual(lsp.args, ['--background-index'])
  assert.equal(lsp.extensionToLanguage['.cpp'], 'cpp')
  assert.equal(lsp.declaredIn, CLAUDE_MARKETPLACE_MANIFEST_PATH)
  assert.equal(lsp.declaredBy, 'clangd-lsp')
  assert.equal(
    describePluginComponents(clangd),
    '1 LSP server',
    'and it is what the row says the plugin ships, rather than "No components declared"',
  )
  assert.equal(
    plugins.filter((plugin) => plugin.components.lspServers.length > 0).length,
    12,
    'every LSP plugin the marketplace declares one for',
  )

  // The three fields the entry carries that a row and a pane can show. `strict`
  // is absent from all but fourteen entries and absent means true, which is the
  // marketplace schema's own default — so it is never invented as false.
  assert.equal(clangd.strict, false)
  assert.equal(guidance.strict, true, 'an entry that states nothing is strict')
  const serena = plugins.find((plugin) => plugin.id === 'serena')
  assert.deepEqual(serena?.tags, ['community-managed'])
  const convex = plugins.find((plugin) => plugin.id === 'convex')
  assert.ok(convex?.keywords.includes('realtime'))
  assert.deepEqual(guidance.tags, [], 'and an entry with none carries none, not undefined')

  // The marketplace's own record of what a plugin used to be called. Kept
  // whole: a lookup by the old name has to land on the plugin, or a receipt
  // written before the rename reads as "not installed".
  assert.equal(scanPluginRenames(scan)['adlc'], 'agentforce-adlc')
  assert.equal(Object.keys(scanPluginRenames(scan)).length, 9)
  assert.equal(findScannedPlugin(scan, 'adlc')?.id, 'agentforce-adlc')
  assert.equal(findScannedPlugin(scan, 'agentforce-adlc')?.id, 'agentforce-adlc')
  assert.equal(findScannedPlugin(scan, 'no-such-plugin'), null)
  assert.deepEqual(pluginAliases(scanPluginRenames(scan), 'convex'), ['convex', 'convex-backend'])

  // The source-wide server list carries every plugin's servers, attributed.
  const servers = scan.mcpServers ?? []
  assert.ok(servers.some((s) => s.id === 'context7' && s.declaredBy === 'context7'))
  assert.ok(servers.some((s) => s.id === 'example-server' && s.declaredBy === 'example-plugin'))
  assert.ok(servers.every((s) => s.declaredBy !== ''))
}

async function renamesOfNamesStillListed(): Promise<void> {
  // `renames` is a running log, not a diff of this revision, so it can name a
  // plugin the listing still holds. Both names being live makes the entry a
  // lie for lookup: the old name is a plugin in its own right, and treating it
  // as an alias of the new one lets two rows resolve to one install receipt.
  const scan = await scanPluginTree({
    entries: [],
    skills: [],
    marketplaceManifest: JSON.stringify({
      name: 'm',
      renames: { alpha: 'beta', departed: 'beta' },
      plugins: [
        { name: 'alpha', source: { source: 'github', repo: 'o/alpha' } },
        { name: 'beta', source: { source: 'github', repo: 'o/beta' } },
      ],
    }),
    readFile: async () => null,
  })
  assert.deepEqual(
    scan.pluginRenames,
    { departed: 'beta' },
    'a name the listing still holds keeps itself; only a departed one is an alias',
  )
  assert.deepEqual(pluginAliases(scan.pluginRenames, 'beta'), ['beta', 'departed'])
  assert.equal(findScannedPlugin({ plugins: scan.plugins, pluginRenames: scan.pluginRenames }, 'alpha')?.id, 'alpha')
}

async function linkedPluginRead(): Promise<void> {
  // Opening a linked plugin lists its repository and reads one directory of
  // it with the same rule — here, exercised on an in-tree directory.
  const tree = recorded('claude-plugins-official')
  const files = recordedFiles('claude-plugins-official')
  const skills = scanSkillTree({ entries: tree.tree, commitSha: tree.commitSha })
  const read = await readPluginComponents({
    dir: 'plugins/security-guidance',
    entries: tree.tree,
    skills: skills.skills,
    readFile: async (path) => files.get(path) ?? null,
  })
  assert.equal(read.manifest?.name, 'security-guidance')
  assert.equal(read.manifest?.version, '2.0.7')
  assert.ok(read.components.hooks.length >= 3)
}

async function skillsOnlyRepositories(): Promise<void> {
  // A marketplace of one plugin at the repository root: one in-tree plugin
  // holding every skill.
  const tree = recorded('mattpocock-skills')
  const marketplaceManifest = manifest('mattpocock-skills')
  const skills = scanSkillTree({ entries: tree.tree, commitSha: tree.commitSha, marketplaceManifest })
  const plugins = await scanPluginTree({
    entries: tree.tree,
    skills: skills.skills,
    marketplaceManifest,
    readFile: async () => null,
  })
  assert.equal(plugins.shape, 'claude-marketplace')
  assert.equal(plugins.marketplaceName, 'mattpocock')
  assert.equal(plugins.plugins.length, 1)
  assert.deepEqual(plugins.plugins[0].origin, { kind: 'in-tree', path: '' })
  assert.equal(plugins.plugins[0].components.skills.length, skills.skills.length)

  // No manifest anywhere: the shape is skills, and there are no plugins.
  const bare = await scanPluginTree({
    entries: tree.tree.filter((entry) => !entry.path.startsWith('.claude-plugin/')),
    skills: skills.skills,
    marketplaceManifest: null,
    readFile: async () => null,
  })
  assert.equal(bare.shape, 'skills')
  assert.equal(bare.plugins.length, 0)

  const empty = await scanPluginTree({ entries: [], skills: [], marketplaceManifest: null, readFile: async () => null })
  assert.equal(empty.shape, 'empty')
}

async function rootServers(): Promise<void> {
  // A repository that ships a server without being a plugin.
  const entries: SkillTreeEntry[] = [
    { path: 'server.json', mode: '100644', type: 'blob', sha: 'a' },
    { path: 'README.md', mode: '100644', type: 'blob', sha: 'b' },
  ]
  const registryManifest = JSON.stringify({
    name: 'io.github.exa-labs/exa-mcp-server',
    description: 'Exa search',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.exa.ai/mcp', headers: [{ name: 'x-api-key', value: '${EXA_API_KEY}' }] }],
  })
  const scan = await scanPluginTree({
    entries,
    skills: [],
    marketplaceManifest: null,
    readFile: async (path) => (path === 'server.json' ? registryManifest : null),
  })
  assert.equal(scan.shape, 'mcp-server')
  assert.equal(scan.plugins.length, 0)
  assert.equal(scan.mcpServers.length, 1)
  assert.equal(scan.mcpServers[0].id, 'exa-mcp-server')
  assert.equal(scan.mcpServers[0].transport, 'http')
  assert.deepEqual(scan.mcpServers[0].envVarNames, ['EXA_API_KEY'])
  assert.equal(scan.mcpServers[0].declaredIn, 'server.json')

  // A stdio package: the registry's runtime hint becomes the command.
  const npm = parseMcpRegistryManifest(
    { name: 'io.github.acme/thing', packages: [{ registryType: 'npm', identifier: '@acme/thing-mcp', environmentVariables: [{ name: 'ACME_TOKEN' }] }] },
    'server.json'
  )
  assert.equal(npm.length, 1)
  assert.equal(npm[0].command, 'npx')
  assert.deepEqual(npm[0].args, ['-y', '@acme/thing-mcp'])
  assert.deepEqual(npm[0].envVarNames, ['ACME_TOKEN'])

  // A package with no runtime hint is not a server the app can start.
  assert.equal(parseMcpRegistryManifest({ name: 'x', packages: [{ registryType: 'oci', identifier: 'ghcr.io/x' }] }, 'server.json').length, 0)
}

/**
 * A scan cached by an older build. These are kept verbatim beside their source
 * and never migrated, so every field this build added is missing from them —
 * and a reader that trusted the shape on disk crashed the whole Plugins tab,
 * which is also the only place Sync could have replaced the cache from.
 */
function cachedScansPredatingTheseFields(): void {
  const cached = {
    skills: [],
    groups: [],
    groupingSignal: 'none',
    fileCount: 0,
    commitSha: 'abc1234',
    plugins: [
      {
        id: 'security-guidance',
        name: 'security-guidance',
        description: '',
        version: '2.0.7',
        category: '',
        author: 'Anthropic',
        homepage: '',
        origin: { kind: 'in-tree', path: 'plugins/security-guidance' },
        componentsKnown: true,
        // As a scan written before LSP servers were a component kind: no
        // `lspServers`, and no `strict`, `tags` or `keywords` either.
        components: { skills: [], commands: ['review'], agents: [], hooks: [], mcpServers: [], missingSkills: [] },
      },
    ],
  } as unknown as ScanResult

  const plugins = scanPlugins(cached)
  assert.equal(plugins.length, 1)
  assert.deepEqual(plugins[0].components.lspServers, [], 'the missing list reads as empty, not as undefined')
  assert.deepEqual(plugins[0].tags, [])
  assert.deepEqual(plugins[0].keywords, [])
  assert.equal(plugins[0].strict, true, 'absent means strict, the marketplace schema’s own default')
  assert.deepEqual(plugins[0].components.commands, ['review'], 'and what the cache DID hold is untouched')
  assert.equal(
    describePluginComponents(plugins[0]),
    '1 command',
    'the row draws rather than throwing — this is what took the Plugins tab down with it',
  )
  assert.equal(findScannedPlugin(cached, 'security-guidance')?.components.lspServers.length, 0)

  // A scan from before plugins existed at all, and one whose plugin list is
  // already complete: the first has nothing to fill, the second is handed back
  // as it is rather than rebuilt on every read.
  assert.deepEqual(scanPlugins({} as ScanResult), [])
  const current: ScanResult = { ...(cached as ScanResult), plugins: scanPlugins(cached) }
  assert.equal(scanPlugins(current), current.plugins, 'a complete list is the same array, not a copy')
}

async function readBudget(): Promise<void> {
  // The cap bounds the FILE READS a scan makes, and only a plugin whose bytes
  // are in this tree costs one. 238 of the official marketplace's 292 entries
  // are hosted elsewhere and are not fetched until they are opened, so they
  // must not push the in-tree plugins listed after them out of the budget.
  assert.ok(
    MAX_SCANNED_PLUGINS > 292 * 3,
    'and the cap stands well clear of the 292 the official marketplace lists today',
  )

  const linkedEntries = Array.from({ length: MAX_SCANNED_PLUGINS }, (_, index) => ({
    name: `linked-${index}`,
    source: { source: 'github', repo: `owner/repo-${index}` },
  }))
  const entries: SkillTreeEntry[] = [
    { path: `plugins/real/${CLAUDE_PLUGIN_MANIFEST_PATH}`, mode: '100644', type: 'blob', sha: 'a' },
    { path: 'plugins/real/commands/go.md', mode: '100644', type: 'blob', sha: 'b' },
  ]
  // An empty manifest rather than null: a null on a path the TREE LISTED is a
  // read that failed, and this test is about the budget, not about failures.
  const afterLinked = await scanPluginTree({
    entries,
    skills: [],
    marketplaceManifest: JSON.stringify({ name: 'm', plugins: linkedEntries }),
    readFile: async () => '{}',
  })
  const real = afterLinked.plugins.find((plugin) => plugin.id === 'real')
  assert.ok(real)
  assert.equal(real.componentsKnown, true, 'a full budget of linked entries spends nothing')
  assert.deepEqual(real.components.commands, ['go'])

  // Past the cap, a plugin still LISTS — by its directory name — and says its
  // components are unknown rather than showing an empty bundle.
  const many: SkillTreeEntry[] = Array.from({ length: MAX_SCANNED_PLUGINS + 1 }, (_, index) => ({
    // Zero-padded so the sorted directory order is the numeric one and the
    // over-budget plugin is the one this asserts on.
    path: `plugins/p${String(index).padStart(5, '0')}/${CLAUDE_PLUGIN_MANIFEST_PATH}`,
    mode: '100644',
    type: 'blob' as const,
    sha: `s${index}`,
  }))
  const capped = await scanPluginTree({ entries: many, skills: [], marketplaceManifest: null, readFile: async () => '{}' })
  assert.equal(capped.plugins.length, MAX_SCANNED_PLUGINS + 1)
  assert.equal(capped.plugins[MAX_SCANNED_PLUGINS - 1].componentsKnown, true)
  assert.equal(capped.plugins[MAX_SCANNED_PLUGINS].componentsKnown, false, 'the one past the cap is unread, not empty')
  assert.equal(capped.plugins[MAX_SCANNED_PLUGINS].id, `p${String(MAX_SCANNED_PLUGINS).padStart(5, '0')}`)
}

function parsers(): void {
  // Language servers: a declaration naming no command could never be started,
  // and an id that is not a name is not carried into anything that launches.
  const lsp = parseLspServers(
    {
      good: { command: 'gopls', args: ['--stdio', 7], extensionToLanguage: { '.go': 'go' }, startupTimeout: 120000 },
      silent: { extensionToLanguage: { '.x': 'x' } },
      '../evil': { command: 'rm' },
    },
    '.claude-plugin/plugin.json',
    'p',
  )
  assert.equal(lsp.length, 1)
  assert.equal(lsp[0].id, 'good')
  assert.deepEqual(lsp[0].args, ['--stdio'], 'a non-string arg is dropped rather than stringified')
  assert.equal(lsp[0].startupTimeout, 120000)
  assert.equal(lsp[0].declaredBy, 'p')
  assert.deepEqual(parseLspServers(null, 'x', ''), [])
  assert.equal(parseLspServers({ a: { command: 'a' } }, 'x', '')[0].startupTimeout, 0, 'never a guessed timeout')

  // Hooks: wrapped and bare, matcher kept, entries without a command dropped.
  const wrapped = parseHooks({
    hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node check.js' }, { type: 'prompt' }] }] },
  })
  assert.deepEqual(wrapped, [{ event: 'PreToolUse', matcher: 'Edit|Write', command: 'node check.js' }])
  const bare = parseHooks({ Stop: [{ hooks: [{ command: 'echo done' }] }] })
  assert.deepEqual(bare, [{ event: 'Stop', matcher: '', command: 'echo done' }])
  assert.deepEqual(parseHooks('nope'), [])

  // Servers: an entry naming neither a command nor a URL is not a server; a
  // hostile id is dropped rather than carried into a config file.
  const servers = parseMcpServers(
    {
      mcpServers: {
        good: { command: 'npx', args: ['-y', 'thing', '--token', '${TOKEN}'], env: { OTHER: '$OTHER_VAR' } },
        nothing: { type: 'stdio' },
        '../evil': { command: 'rm' },
      },
    },
    '.mcp.json',
    'p'
  )
  assert.equal(servers.length, 1)
  assert.equal(servers[0].id, 'good')
  assert.deepEqual(servers[0].envVarNames, ['OTHER_VAR', 'TOKEN'])

  // Marketplace sources: relative paths stay in-tree, traversal is refused,
  // github objects resolve, non-GitHub hosts list with no repository.
  const parsed = parseMarketplaceManifest(
    JSON.stringify({
      name: 'm',
      plugins: [
        { name: 'a', source: './plugins/a' },
        { name: 'b', source: '../outside' },
        { name: 'c', source: { source: 'github', repo: 'o/r', ref: 'main' } },
        { name: 'd', source: { source: 'git', url: 'https://gitlab.com/o/r.git' } },
        { name: 'a', source: './dup' },
        { source: './noname' },
      ],
    })
  )
  assert.ok(parsed)
  assert.deepEqual(parsed.plugins.map((plugin) => plugin.name), ['a', 'c', 'd'])
  assert.deepEqual(parsed.plugins[0].source, { kind: 'in-tree', path: 'plugins/a' })
  assert.deepEqual(parsed.plugins[1].source, { kind: 'linked', repo: 'o/r', ref: 'main', sha: '', path: '', url: 'https://github.com/o/r' })
  assert.equal((parsed.plugins[2].source as { repo: string }).repo, '')
  assert.equal(parseMarketplaceManifest('{"plugins": "no"}'), null)
  assert.equal(parseMarketplaceManifest(null), null)

  // Renames: kept whole, including one that names a plugin the listing does not
  // hold — the marketplace still says that is what the plugin used to be
  // called. A self-map is dropped; it would make a lookup chase its own tail.
  const renamed = parseMarketplaceManifest(
    JSON.stringify({
      name: 'm',
      renames: { was: 'a', gone: 'never-listed', self: 'self', '': 'x', bad: 4 },
      plugins: [{ name: 'a', source: './a' }],
    }),
  )
  assert.deepEqual(renamed?.renames, { was: 'a', gone: 'never-listed' })

  assert.equal(githubRepoFromUrl('https://github.com/o/r.git'), 'o/r')
  assert.equal(githubRepoFromUrl('https://github.com/o/r/tree/main/x'), 'o/r')
  assert.equal(githubRepoFromUrl('https://example.com/o/r'), '')
  assert.equal(githubRepoFromUrl('not a url'), '')
}

// ── Following linked plugins ────────────────────────────────────────────────
//
// Recorded against three of the marketplace's real linked repositories at the
// commits it pins: carta/plugins (three of its plugins in three subdirectories,
// which is what proves one tree listing answers for all three),
// 42Crunch-AI/claude-plugins (one subdirectory) and
// SalesforceAIResearch/agentforce-adlc (the whole repository as one plugin).

type RecordedRepos = {
  repos: Record<string, { repo: string; commitSha: string; tree: SkillTreeEntry[]; files: Record<string, string> }>
}

const LINKED_REPOS = JSON.parse(
  readFileSync(join(FIXTURES, 'linked-plugin-repos.json'), 'utf8')
) as RecordedRepos

/** The four plugins the fixture repositories back, and one it deliberately does not. */
const RECORDED_PLUGINS = [
  '42crunch-api-security-testing',
  'agentforce-adlc',
  'carta-cap-table',
  'carta-crm',
  'carta-investors',
]
const UNRECORDED_PLUGIN = 'convex'
const CONVEX_REPO = 'get-convex/convex-backend-skill@6ca54f6e2e7582812187b8a5a4783fb4dff52692'

/**
 * A reader over the recorded repositories that counts every call, so a test can
 * assert what a pass SPENT rather than only what it produced. A repository the
 * fixture does not hold fails the way GitHub fails for a commit that is gone.
 */
type CountingReader = LinkedPluginRepoReader & { trees: string[]; commits: string[] }

function recordedReader(
  options: { rateLimitOn?: string; offlineOn?: string; resolvesTo?: Record<string, string> } = {},
): CountingReader {
  const trees: string[] = []
  const commits: string[] = []
  return {
    trees,
    commits,
    // A marketplace that pinned no commit: the ref is resolved once for the
    // whole group, and that resolved commit is what the cache is keyed by.
    resolveCommit: async (repo, ref) => {
      commits.push(`${repo}#${ref}`)
      const resolved = options.resolvesTo?.[repo]
      if (resolved === undefined) throw new LinkedPluginReadError(`No commit could be resolved for ${repo}.`, 'unreadable')
      return resolved
    },
    readTree: async (repo, sha) => {
      trees.push(`${repo}@${sha}`)
      // Matched as a prefix, because neither a rate limit nor a dead network is
      // aimed at one repository: it is the minute, and every request in it
      // fails alike.
      if (options.offlineOn !== undefined && repo.startsWith(options.offlineOn)) {
        throw new LinkedPluginReadError('Could not reach GitHub. fetch failed', 'offline')
      }
      if (options.rateLimitOn !== undefined && repo.startsWith(options.rateLimitOn)) {
        throw new LinkedPluginReadError(
          'GitHub rate-limited this request. Adding a GitHub token in Settings raises the limit.',
          'rate-limited',
        )
      }
      const found = LINKED_REPOS.repos[`${repo}@${sha}`]
      if (!found) throw new LinkedPluginReadError('That repository could not be found, or it is not public.', 'unreadable')
      return found.tree
    },
    readFile: async (repo, sha, path) => LINKED_REPOS.repos[`${repo}@${sha}`]?.files[path] ?? null,
  }
}

const NO_PENDING = { budget: 0, rateLimited: 0, offline: 0 }

/** The head line's shortfall clauses as one sentence, the way the head line reads. */
function shortfallLine(summary: LinkedPluginSummary, tokenConfigured: boolean): string | null {
  const parts = linkedPluginShortfall(summary, tokenConfigured)
  return parts.length > 0 ? parts.map((part) => part.text).join('; ') : null
}

function unreadableMessage(plugin: ScannedPlugin): string {
  const state = plugin.readState
  assert.equal(state?.status, 'unreadable', `${plugin.id} was expected to be unreadable`)
  return state?.status === 'unreadable' ? state.message : ''
}

async function linkedPluginsFollowed(): Promise<void> {
  const scan = await scanOfficial()
  const marketplaceManifest = manifest('claude-plugins-official')
  const all = scanPlugins(scan)
  // The four the fixture backs, one linked plugin whose repository it does not
  // hold, and one in-tree plugin that must come through untouched.
  const subject = [
    ...all.filter((plugin) => RECORDED_PLUGINS.includes(plugin.id)),
    all.find((plugin) => plugin.id === UNRECORDED_PLUGIN)!,
    all.find((plugin) => plugin.id === 'security-guidance')!,
  ]
  assert.equal(subject.length, 7)
  assert.ok(subject.every((plugin) => plugin !== undefined))

  const reader = recordedReader()
  const first = await followLinkedPlugins({
    plugins: subject,
    reader,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest,
  })

  // Batching: six linked plugins over four distinct repositories, and the
  // three carta plugins cost ONE tree listing between them.
  assert.equal(reader.trees.length, 4)
  assert.equal(reader.trees.filter((key) => key.startsWith('carta/plugins@')).length, 1)
  assert.equal(first.repositoriesRead, 3, 'the fourth repository is not in the fixture and failed')
  assert.equal(reader.commits.length, 0, 'every entry is pinned, so no ref is resolved')

  const byId = new Map(first.plugins.map((plugin) => [plugin.id, plugin]))
  const capTable = byId.get('carta-cap-table')!
  assert.equal(capTable.componentsKnown, true)
  assert.deepEqual(
    capTable.readState,
    { status: 'listed' },
    'listed, not read: the components are real, but no skill entry document was fetched',
  )
  assert.ok(capTable.components.skills.length > 0)
  assert.ok(capTable.components.hooks.length > 0, 'its hooks/hooks.json was read from ITS repository')
  assert.ok(
    capTable.components.skills.every((skill) => skill.id.startsWith('plugins/carta-cap-table/skills/')),
    'and it took only the skills under its own directory, not its two neighbours',
  )
  const crm = byId.get('carta-crm')!
  assert.equal(crm.componentsKnown, true)
  assert.ok(crm.components.skills.length > 0)
  assert.ok(crm.components.skills.every((skill) => skill.id.startsWith('plugins/carta-crm/skills/')))

  // The marketplace entry's words still outrank the plugin manifest's, exactly
  // as they do for an in-tree plugin.
  // A `url` entry is the whole repository: the plugin's directory is its root.
  const adlc = byId.get('agentforce-adlc')!
  assert.equal(adlc.componentsKnown, true)
  assert.equal(adlc.components.skills.length, 3)
  assert.equal(adlc.components.agents.length, 4)

  const crunch = byId.get('42crunch-api-security-testing')!
  assert.equal(crunch.author, '42Crunch')
  assert.equal(crunch.components.skills.length, 5)
  assert.ok(
    describePluginComponents(crunch).startsWith('5 skills'),
    'and the row says what it ships instead of "Read when opened"',
  )

  // The repository the fixture does not hold is LISTED, saying why.
  const convex = byId.get(UNRECORDED_PLUGIN)!
  assert.equal(convex.componentsKnown, false)
  assert.match(unreadableMessage(convex), /could not be found/, 'the reason GitHub gave, not a shrug')
  assert.equal(describePluginComponents(convex), unreadableMessage(convex))

  // The in-tree plugin is untouched, components and all.
  const guidance = byId.get('security-guidance')!
  assert.deepEqual(guidance.readState, { status: 'read' }, 'an in-tree plugin was read whole, entry documents included')
  assert.ok(guidance.components.hooks.length >= 3)

  // The servers the followed plugins declare come back for the source's list,
  // each attributed to the plugin that declared it.
  assert.ok(first.mcpServers.every((server) => server.declaredBy !== ''))

  // ── The cache: an unchanged pinned sha costs no request at all ────────────
  const reread = recordedReader()
  const cachedRun = await followLinkedPlugins({
    plugins: subject,
    reader: reread,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest,
    cached: first.plugins,
  })
  assert.deepEqual(reread.trees, [CONVEX_REPO], 'only the repository that never answered is asked again')
  assert.equal(cachedRun.repositoriesRead, 0)
  const cachedCrm = cachedRun.plugins.find((plugin) => plugin.id === 'carta-crm')!
  assert.equal(
    cachedCrm.components.skills.length,
    crm.components.skills.length,
    'and a cached plugin keeps the components the earlier read gave it',
  )
  // …and everything the LINKED repository's own manifest filled in. All 238 of
  // the official marketplace's linked entries state no version and 70 state no
  // author, so a reuse that kept only the entry's fields blanked the version on
  // 238 rows at the second Sync (linked-plugins review, 2026-09-06).
  assert.ok(crm.version !== '', 'the version came from the linked repository, not the entry')
  assert.equal(cachedCrm.version, crm.version)
  assert.equal(cachedCrm.author, crm.author)
  assert.equal(cachedCrm.homepage, crm.homepage)
  assert.equal(cachedCrm.description, crm.description)
  assert.equal(cachedCrm.readCommit, crm.readCommit)
  assert.equal(cachedCrm.componentsKnown, true)

  // The cache is keyed on the whole address, not the commit alone: a
  // marketplace that moves a plugin's subdirectory at an unchanged sha must not
  // be served components from a directory that no longer exists.
  const relocated = subject.map((plugin) =>
    plugin.id === 'carta-crm' && plugin.origin.kind === 'linked'
      ? { ...plugin, origin: { ...plugin.origin, path: 'plugins/carta-investors' } }
      : plugin,
  )
  const relocatedReader = recordedReader()
  const afterMove = await followLinkedPlugins({
    plugins: relocated,
    reader: relocatedReader,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest,
    cached: first.plugins,
  })
  assert.ok(
    relocatedReader.trees.includes('carta/plugins@cf7e25ef8d8ff5ec9f6194eafae9a809f66ffff4'),
    'the moved plugin is read again even though its commit did not move',
  )
  assert.ok(
    afterMove.plugins
      .find((plugin) => plugin.id === 'carta-crm')!
      .components.skills.every((skill) => skill.id.startsWith('plugins/carta-investors/skills/')),
    'and it lists the directory it points at NOW, not the one the cache held',
  )

  // A sha that MOVED is read again: the cache is keyed by the pinned commit.
  const moved = subject.map((plugin) =>
    plugin.id === 'carta-crm' && plugin.origin.kind === 'linked'
      ? { ...plugin, origin: { ...plugin.origin, sha: 'f'.repeat(40) } }
      : plugin,
  )
  const movedReader = recordedReader()
  await followLinkedPlugins({
    plugins: moved,
    reader: movedReader,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest,
    cached: first.plugins,
  })
  assert.ok(
    movedReader.trees.includes(`carta/plugins@${'f'.repeat(40)}`),
    'the moved plugin is re-read at its new commit',
  )
  assert.ok(
    !movedReader.trees.includes('carta/plugins@cf7e25ef8d8ff5ec9f6194eafae9a809f66ffff4'),
    'and its two neighbours, still pinned where they were, are not',
  )
}

async function linkedPluginsPartial(): Promise<void> {
  const scan = await scanOfficial()
  const marketplaceManifest = manifest('claude-plugins-official')
  const all = scanPlugins(scan)

  // No budget at all: nothing is fetched, nothing is invented, and the head
  // line states the whole shortfall along with the setting that fixes it.
  const none = recordedReader()
  const unread = await followLinkedPlugins({ plugins: all, reader: none, budget: 0, marketplaceManifest })
  assert.equal(none.trees.length, 0)
  const summary = summariseLinkedPlugins({ plugins: unread.plugins })
  assert.deepEqual(summary, {
    total: 238,
    read: 0,
    pending: 238,
    unreadable: 0,
    pendingReasons: { budget: 238, rateLimited: 0, offline: 0 },
  })
  assert.equal(
    shortfallLine(summary, false),
    '238 of 238 linked plugins not yet read — add a GitHub token',
  )
  assert.equal(
    shortfallLine(summary, true),
    '238 of 238 linked plugins not yet read — Sync to read the rest',
    'with a token already in hand the honest next step is Sync, not a setting that is set',
  )
  // The clause naming the token IS the button, so the head line can offer the
  // setting rather than describe where to find it.
  assert.deepEqual(
    linkedPluginShortfall(summary, false).map((part) => part.action),
    ['github-settings'],
  )
  assert.deepEqual(linkedPluginShortfall(summary, true).map((part) => part.action), [null])
  assert.equal(
    describePluginComponents(unread.plugins.find((plugin) => plugin.id === UNRECORDED_PLUGIN)!),
    'Not read yet — read when opened',
  )
  assert.equal(shortfallLine({ total: 0, read: 0, pending: 0, unreadable: 0, pendingReasons: NO_PENDING }, false), null)
  assert.equal(
    shortfallLine({ total: 238, read: 238, pending: 0, unreadable: 0, pendingReasons: NO_PENDING }, false),
    null,
    'a source that read them all says nothing extra: the counts already stand',
  )
  // The remedy is whatever is actually in the way. "Add a GitHub token" is
  // useless advice to a machine with no network, and a spent limit is not
  // cleared by pressing Sync again this minute (linked-plugins review).
  const offlineSummary = { total: 10, read: 0, pending: 10, unreadable: 0, pendingReasons: { budget: 0, rateLimited: 0, offline: 10 } }
  assert.equal(shortfallLine(offlineSummary, false), '10 of 10 linked plugins not yet read — GitHub could not be reached')
  assert.deepEqual(linkedPluginShortfall(offlineSummary, false).map((part) => part.action), [null], 'and it offers no setting')
  const limitedSummary = { total: 10, read: 0, pending: 10, unreadable: 0, pendingReasons: { budget: 0, rateLimited: 10, offline: 0 } }
  assert.equal(
    shortfallLine(limitedSummary, true),
    "10 of 10 linked plugins not yet read — Sync once GitHub's rate limit resets",
  )
  assert.equal(
    shortfallLine(limitedSummary, false),
    '10 of 10 linked plugins not yet read — add a GitHub token',
    'without a token, raising the limit IS the fix for a spent limit',
  )

  // A partial budget: as many as it allows, the rest stated as pending.
  const partialReader = recordedReader()
  const subject = all.filter((plugin) => RECORDED_PLUGINS.includes(plugin.id))
  const partial = await followLinkedPlugins({
    plugins: subject,
    reader: partialReader,
    budget: 1,
    marketplaceManifest,
  })
  assert.equal(partialReader.trees.length, 1, 'the budget is spent on repositories, not on plugins')
  const partialSummary = summariseLinkedPlugins({ plugins: partial.plugins })
  assert.equal(partialSummary.total, 5)
  assert.ok(partialSummary.read > 0 && partialSummary.pending > 0)
  assert.equal(partialSummary.read + partialSummary.pending, 5)
  for (const plugin of partial.plugins) {
    if (plugin.componentsKnown) continue
    assert.deepEqual(plugin.readState, { status: 'pending', reason: 'budget' })
  }

  // A repository that failed last time never crowds out one nobody has read.
  const failedBefore = subject.map((plugin) =>
    plugin.id === '42crunch-api-security-testing'
      ? { ...plugin, readState: { status: 'unreadable' as const, message: 'gone' } }
      : plugin,
  )
  const orderReader = recordedReader()
  await followLinkedPlugins({
    plugins: subject,
    reader: orderReader,
    budget: 1,
    marketplaceManifest,
    cached: failedBefore,
  })
  assert.ok(
    !orderReader.trees.some((key) => key.startsWith('42Crunch-AI/')),
    'the retry waits; the budget goes to a repository that has never answered',
  )

  // The rate limit stops the pass rather than spending the rest of the hour on
  // requests that would all fail the same way — and says so, because it resets.
  const limited = recordedReader({ rateLimitOn: 'carta/plugins' })
  const capped = await followLinkedPlugins({
    plugins: subject,
    reader: limited,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest,
  })
  const carta = capped.plugins.find((plugin) => plugin.id === 'carta-crm')!
  assert.deepEqual(
    carta.readState,
    { status: 'pending', reason: 'rate-limited', blocked: true },
    'pending, not unreadable: the limit resets and the next scan will read it',
  )
  assert.equal(describePluginComponents(carta), 'Not read — GitHub rate limit reached')
  assert.equal(
    capped.plugins.find((plugin) => plugin.id === 'agentforce-adlc')?.componentsKnown,
    true,
    'and a repository that answered before the limit keeps what it said',
  )

  // …and with more repositories than the pass runs at once, the ones it has not
  // started are never asked for: an hour of requests that would all fail the
  // same way is the storm the budget and this stop exist to prevent.
  const crowd = await scanPluginTree({
    entries: [],
    skills: [],
    marketplaceManifest: JSON.stringify({
      name: 'm',
      plugins: Array.from({ length: 60 }, (_, index) => ({
        name: `linked-${index}`,
        source: { source: 'github', repo: `owner/repo-${index}`, sha: String(index).padStart(40, '0') },
      })),
    }),
    readFile: async () => null,
  })
  const flooded = recordedReader({ rateLimitOn: 'owner/' })
  const stopped = await followLinkedPlugins({
    plugins: crowd.plugins,
    reader: flooded,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest: null,
  })
  assert.equal(crowd.plugins.length, 60)
  assert.ok(flooded.trees.length < 60, `the pass stopped after ${flooded.trees.length} of 60 repositories`)
  assert.equal(stopped.repositoriesRead, 0)
  assert.ok(
    stopped.plugins.every((plugin) => plugin.readState?.status === 'pending'),
    'every plugin it did not reach is pending, none of them unreadable',
  )
  assert.equal(
    summariseLinkedPlugins({ plugins: stopped.plugins }).pending,
    60,
    'and the head line counts all sixty as not yet read',
  )

  // A host this app cannot read costs no request at all and names the host.
  const offSite = await scanPluginTree({
    entries: [],
    skills: [],
    marketplaceManifest: JSON.stringify({
      name: 'm',
      plugins: [{ name: 'off-site', source: { source: 'git', url: 'https://gitlab.com/o/r.git' } }],
    }),
    readFile: async () => null,
  })
  const refusedReader = recordedReader()
  const refused = await followLinkedPlugins({
    plugins: offSite.plugins,
    reader: refusedReader,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest: null,
  })
  assert.equal(refusedReader.trees.length, 0)
  assert.equal(unreadableMessage(refused.plugins[0]), "Hosted on gitlab.com, which is not on this app's allowlist.")
  assert.deepEqual(summariseLinkedPlugins({ plugins: refused.plugins }), {
    total: 1,
    read: 0,
    pending: 0,
    unreadable: 1,
    pendingReasons: { budget: 0, rateLimited: 0, offline: 0 },
  })
  assert.equal(
    shortfallLine({ total: 1, read: 0, pending: 0, unreadable: 1, pendingReasons: NO_PENDING }, true),
    '1 of 1 linked plugin could not be read in full',
  )

  // …and a budget that fits every repository still reads them all, which is
  // what "a full scan with a token" means: 250 stands clear of the 220 distinct
  // pinned repositories the official marketplace resolves to today.
  assert.equal(linkedRepositoryBudget('ghp_x'), MAX_LINKED_REPOSITORY_READS)
  assert.equal(linkedRepositoryBudget(''), MAX_LINKED_REPOSITORY_READS_ANONYMOUS)
  assert.equal(linkedRepositoryBudget(undefined), MAX_LINKED_REPOSITORY_READS_ANONYMOUS)
  assert.equal(distinctPinnedRepositories(all), 220)
  assert.ok(MAX_LINKED_REPOSITORY_READS > distinctPinnedRepositories(all))

  // A dead network is not a dead repository. It stops the pass the way the rate
  // limit does and leaves everything pending, because both come back — telling
  // somebody on a train that 238 repositories could not be read would be a
  // permanent-sounding verdict on a temporary fact.
  const offline = recordedReader({ offlineOn: 'owner/' })
  const dark = await followLinkedPlugins({
    plugins: crowd.plugins,
    reader: offline,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest: null,
  })
  assert.ok(offline.trees.length < 60, 'it stops rather than firing sixty requests at nothing')
  assert.deepEqual(summariseLinkedPlugins({ plugins: dark.plugins }), {
    total: 60,
    read: 0,
    pending: 60,
    unreadable: 0,
    pendingReasons: { budget: 0, rateLimited: 0, offline: 60 },
  })
  assert.ok(
    dark.plugins.some((plugin) => plugin.readState?.status === 'pending' && plugin.readState.blocked === true),
    'the repository whose reply stopped the pass is marked, so the next pass ranks it last',
  )
  assert.equal(dark.plugins[59].readState?.status, 'pending')
  assert.equal(describePluginComponents(dark.plugins[59]), 'Not read — GitHub could not be reached')
  assert.match(describeUnreadPlugin(dark.plugins[59]), /Sync when the connection is back/)

  // An entry the marketplace did NOT pin: its ref is resolved once for the
  // group, and the commit that comes back is what the plugin ends up pinned to.
  const unpinnedManifest = JSON.stringify({
    name: 'm',
    plugins: [
      { name: 'floating-a', source: { source: 'github', repo: 'carta/plugins', ref: 'main', path: 'plugins/carta-crm' } },
      { name: 'floating-b', source: { source: 'github', repo: 'carta/plugins', ref: 'main', path: 'plugins/carta-investors' } },
    ],
  })
  const unpinned = await scanPluginTree({
    entries: [],
    skills: [],
    marketplaceManifest: unpinnedManifest,
    readFile: async () => '{}',
  })
  const resolving = recordedReader({ resolvesTo: { 'carta/plugins': 'cf7e25ef8d8ff5ec9f6194eafae9a809f66ffff4' } })
  const floated = await followLinkedPlugins({
    plugins: unpinned.plugins,
    reader: resolving,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest: null,
  })
  assert.deepEqual(resolving.commits, ['carta/plugins#main'], 'one resolve for the group, not one per plugin')
  assert.equal(resolving.trees.length, 1, 'and one tree after it')
  assert.equal(floated.repositoriesRead, 1)
  assert.ok(floated.plugins.every((plugin) => plugin.componentsKnown))
  assert.equal(
    floated.plugins[0].origin.kind === 'linked' ? floated.plugins[0].origin.sha : 'x',
    '',
    'the entry stays UNPINNED: what the marketplace pinned is not what a scan happened to resolve',
  )
  assert.equal(
    floated.plugins[0].readCommit,
    'cf7e25ef8d8ff5ec9f6194eafae9a809f66ffff4',
    'the commit this read used is recorded beside it, not written into the origin',
  )

  // An unpinned entry is re-read every scan, and the input a later scan gets is
  // the manifest PARSED AGAIN — never the sha-stamped plugins the last pass
  // produced, which is a shape production never hands it (linked-plugins
  // review, 2026-09-06).
  const reparsed = await scanPluginTree({
    entries: [],
    skills: [],
    marketplaceManifest: unpinnedManifest,
    readFile: async () => '{}',
  })
  const again = recordedReader({ resolvesTo: { 'carta/plugins': 'cf7e25ef8d8ff5ec9f6194eafae9a809f66ffff4' } })
  const refloated = await followLinkedPlugins({
    plugins: reparsed.plugins,
    reader: again,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest: null,
    cached: floated.plugins,
  })
  assert.deepEqual(again.commits, ['carta/plugins#main'], 'no pin, no cache: the ref is resolved again')
  assert.equal(again.trees.length, 1)
  assert.ok(refloated.plugins.every((plugin) => plugin.componentsKnown))

  // …and the resolve is charged against the budget before it is spent, so
  // unpinned entries cannot quietly outspend it. One ref-bearing group costs
  // one resolve plus one tree, which a budget of one cannot afford.
  const broke = recordedReader({ resolvesTo: { 'carta/plugins': 'cf7e25ef8d8ff5ec9f6194eafae9a809f66ffff4' } })
  const starved = await followLinkedPlugins({
    plugins: reparsed.plugins,
    reader: broke,
    budget: 1,
    marketplaceManifest: null,
  })
  assert.deepEqual(broke.commits, [], 'the resolve never happened: the budget could not cover it')
  assert.deepEqual(broke.trees, [])
  assert.ok(starved.plugins.every((plugin) => plugin.readState?.status === 'pending'))

  // A linked source path may not climb out of the plugin's directory, the same
  // rule the in-tree branch has always applied.
  const traversal = parseMarketplaceManifest(
    JSON.stringify({
      name: 'm',
      plugins: [
        { name: 'escape', source: { source: 'github', repo: 'o/r', path: '../../etc' } },
        { name: 'fine', source: { source: 'github', repo: 'o/r', path: 'plugins/ok' } },
      ],
    }),
  )
  assert.deepEqual(traversal?.plugins.map((plugin) => plugin.name), ['fine'])
}

/**
 * An infinite budget reads every repository the marketplace names.
 *
 * That is what the git transport passes (git-transport ruling, owner
 * 2026-09-08): a tree listing over git's protocol is not a REST request, so
 * there is nothing left for a per-scan budget to protect and Sync must read
 * every plugin. The arithmetic here is the anonymous API budget's — twenty of
 * sixty repositories, forty left `pending: 'budget'` — beside the same pass
 * with no ceiling at all.
 */
async function anInfiniteBudgetReadsEveryRepository(): Promise<void> {
  const REPOSITORIES = 60
  const crowd = await scanPluginTree({
    entries: [],
    skills: [],
    marketplaceManifest: JSON.stringify({
      name: 'm',
      plugins: Array.from({ length: REPOSITORIES }, (_, index) => ({
        name: `linked-${index}`,
        source: { source: 'github', repo: `owner/repo-${index}`, sha: String(index).padStart(40, '0') },
      })),
    }),
    readFile: async () => null,
  })
  assert.equal(crowd.plugins.length, REPOSITORIES)

  /** A reader every repository answers: one skill, no manifest to lose. */
  const answering = (): LinkedPluginRepoReader & { trees: string[] } => {
    const trees: string[] = []
    return {
      trees,
      resolveCommit: async () => '0'.repeat(40),
      readTree: async (repo, sha) => {
        trees.push(`${repo}@${sha}`)
        return [{ path: 'skills/demo/SKILL.md', mode: '100644', type: 'blob', sha: 'a' }]
      },
      readFile: async () => null,
    }
  }

  const budgeted = answering()
  const rationed = await followLinkedPlugins({
    plugins: crowd.plugins,
    reader: budgeted,
    budget: MAX_LINKED_REPOSITORY_READS_ANONYMOUS,
    marketplaceManifest: null,
  })
  assert.equal(budgeted.trees.length, MAX_LINKED_REPOSITORY_READS_ANONYMOUS)
  assert.deepEqual(summariseLinkedPlugins({ plugins: rationed.plugins }), {
    total: REPOSITORIES,
    read: MAX_LINKED_REPOSITORY_READS_ANONYMOUS,
    pending: REPOSITORIES - MAX_LINKED_REPOSITORY_READS_ANONYMOUS,
    unreadable: 0,
    pendingReasons: { budget: REPOSITORIES - MAX_LINKED_REPOSITORY_READS_ANONYMOUS, rateLimited: 0, offline: 0 },
  })

  const unbounded = answering()
  const whole = await followLinkedPlugins({
    plugins: crowd.plugins,
    reader: unbounded,
    budget: Number.POSITIVE_INFINITY,
    marketplaceManifest: null,
  })
  assert.equal(unbounded.trees.length, REPOSITORIES, 'every group is read, none sliced away')
  assert.equal(whole.repositoriesRead, REPOSITORIES)
  assert.ok(whole.plugins.every((plugin) => plugin.componentsKnown))
  assert.equal(
    whole.plugins.filter((plugin) => plugin.readState?.status === 'pending').length,
    0,
    'nothing is left pending, for budget or for anything else',
  )
  assert.deepEqual(summariseLinkedPlugins({ plugins: whole.plugins }), {
    total: REPOSITORIES,
    read: REPOSITORIES,
    pending: 0,
    unreadable: 0,
    pendingReasons: NO_PENDING,
  })

  // An unpinned entry charges its resolve against the budget before spending
  // it, and `spent + cost > Infinity` is never true — so the ref is resolved
  // and the tree read rather than the group being written off as unaffordable.
  const unpinned = await scanPluginTree({
    entries: [],
    skills: [],
    marketplaceManifest: JSON.stringify({
      name: 'm',
      plugins: [{ name: 'floating', source: { source: 'github', repo: 'owner/floating' } }],
    }),
    readFile: async () => null,
  })
  const floating = answering()
  const floated = await followLinkedPlugins({
    plugins: unpinned.plugins,
    reader: floating,
    budget: Number.POSITIVE_INFINITY,
    marketplaceManifest: null,
  })
  assert.equal(floating.trees.length, 1)
  assert.equal(floated.plugins[0].componentsKnown, true)
}

/**
 * The shortfall's remedy over git: Sync, and never the token.
 *
 * On the API path a token is what raises 60 requests an hour to 5,000, so
 * naming it is the one useful thing to say. Over git the limit is not what is
 * in the way — nothing is rationed — and a machine with no git at all is told
 * the one thing that would actually change the answer (git-transport ruling,
 * owner 2026-09-08).
 */
function shortfallReadsTheTransport(): void {
  const pending: LinkedPluginSummary = {
    total: 238,
    read: 0,
    pending: 238,
    unreadable: 0,
    pendingReasons: { budget: 238, rateLimited: 0, offline: 0 },
  }
  assert.deepEqual(linkedPluginShortfall(pending, false, 'git'), [
    { text: '238 of 238 linked plugins not yet read — Sync to read the rest', action: null },
  ])
  assert.deepEqual(
    linkedPluginShortfall(pending, true, 'git'),
    linkedPluginShortfall(pending, false, 'git'),
    'the token decides nothing over git, so it changes no word of this',
  )

  // A rate limit cannot be git's problem, so its clause does not appear either.
  const limited: LinkedPluginSummary = {
    total: 10,
    read: 0,
    pending: 10,
    unreadable: 0,
    pendingReasons: { budget: 0, rateLimited: 10, offline: 0 },
  }
  assert.deepEqual(linkedPluginShortfall(limited, false, 'git'), [
    { text: '10 of 10 linked plugins not yet read — Sync to read the rest', action: null },
  ])

  // A dead network is still a dead network, whichever protocol was speaking.
  const offline: LinkedPluginSummary = {
    total: 10,
    read: 0,
    pending: 10,
    unreadable: 0,
    pendingReasons: { budget: 0, rateLimited: 0, offline: 10 },
  }
  assert.deepEqual(linkedPluginShortfall(offline, false, 'git'), [
    { text: '10 of 10 linked plugins not yet read — GitHub could not be reached', action: null },
  ])

  // The API fallback keeps every word it had…
  assert.deepEqual(linkedPluginShortfall(pending, false, 'api'), [
    { text: '238 of 238 linked plugins not yet read — add a GitHub token', action: 'github-settings' },
  ])
  assert.deepEqual(
    linkedPluginShortfall(pending, false),
    linkedPluginShortfall(pending, false, 'api'),
    'and a caller that names no transport gets the API wording it always got',
  )
  // …except on the machine that is on the API path because it has no git,
  // where the token would only widen a limit it should not be meeting at all.
  assert.deepEqual(linkedPluginShortfall(pending, false, 'api', false), [
    { text: '238 of 238 linked plugins not yet read — install git', action: null },
  ])
  assert.deepEqual(
    linkedPluginShortfall(pending, true, 'api', false).map((part) => part.action),
    [null],
    'and it offers no setting, because no setting installs git',
  )
}

/**
 * A read that lost a file the tree listed is not a read plugin.
 *
 * This is the install gate's foundation: `installPlugin` refuses a plugin whose
 * components are not known, and the hooks acknowledgement is only ever shown
 * for hooks that were actually read. A `hooks/hooks.json` lost to a throttled
 * raw request used to come back as a plugin with no hooks and
 * `componentsKnown: true`, which is the one shape that walks past both
 * (linked-plugins review, 2026-09-06).
 */
async function aLostFileIsNotAnAbsentFile(): Promise<void> {
  const tree = recorded('claude-plugins-official')
  const files = recordedFiles('claude-plugins-official')
  const skills = scanSkillTree({ entries: tree.tree, commitSha: tree.commitSha })
  const hooksPath = 'plugins/security-guidance/hooks/hooks.json'
  assert.ok(files.has(hooksPath), 'the fixture holds the file this test then refuses to serve')

  const whole = await readPluginComponents({
    dir: 'plugins/security-guidance',
    entries: tree.tree,
    skills: skills.skills,
    readFile: async (path) => files.get(path) ?? null,
  })
  assert.deepEqual(whole.unreadFiles, [])
  assert.ok(whole.components.hooks.length >= 3)

  const throttled = await readPluginComponents({
    dir: 'plugins/security-guidance',
    entries: tree.tree,
    skills: skills.skills,
    readFile: async (path) => (path === hooksPath ? null : files.get(path) ?? null),
  })
  assert.deepEqual(throttled.unreadFiles, [hooksPath], 'the tree listed it, so a null is a failure')
  assert.equal(throttled.components.hooks.length, 0)

  // …and the scan that produced it says so, rather than caching a plugin that
  // claims to ship no hooks.
  const marketplaceManifest = manifest('claude-plugins-official')
  const scanned = await scanPluginTree({
    entries: tree.tree,
    skills: skills.skills,
    marketplaceManifest,
    readFile: async (path) => (path === hooksPath ? null : files.get(path) ?? null),
  })
  const guidance = scanned.plugins.find((plugin) => plugin.id === 'security-guidance')!
  assert.equal(guidance.componentsKnown, false, 'not a complete plugin, so the install gate cannot be walked past')
  assert.deepEqual(guidance.readState, { status: 'partial', unread: [hooksPath] })
  assert.equal(unreadPluginChip(guidance), 'Partly read')
  assert.equal(describePluginComponents(guidance), 'Partly read — 1 file could not be read')
  assert.match(describeUnreadPlugin(guidance), /could not be read, so this is not all of the plugin/)
  assert.equal(unreadPluginReason(guidance), 'incomplete', 'neither "open it" nor "past the scan limit"')

  // The same on the linked side, where the request is a raw read of another
  // repository and throttling is likeliest.
  const all = scanPlugins({ ...scanned })
  const crunch = all.find((plugin) => plugin.id === '42crunch-api-security-testing')!
  const manifestPath = 'plugins/api-security-testing/.claude-plugin/plugin.json'
  const partialReader = recordedReader()
  const brokenReader: LinkedPluginRepoReader = {
    ...partialReader,
    readFile: async (repo, sha, path) => (path === manifestPath ? null : partialReader.readFile(repo, sha, path)),
  }
  const followed = await followLinkedPlugins({
    plugins: [crunch],
    reader: brokenReader,
    budget: MAX_LINKED_REPOSITORY_READS,
    marketplaceManifest,
  })
  assert.equal(followed.plugins[0].componentsKnown, false)
  assert.deepEqual(followed.plugins[0].readState, { status: 'partial', unread: [manifestPath] })
  assert.deepEqual(
    summariseLinkedPlugins({ plugins: followed.plugins }),
    { total: 1, read: 0, pending: 0, unreadable: 1, pendingReasons: NO_PENDING },
    'a partly-read plugin is counted with the ones that could not be read, never with the read ones',
  )
}

/** How many tree listings a full follow of this marketplace would cost. */
function distinctPinnedRepositories(plugins: readonly ScannedPlugin[]): number {
  const keys = new Set<string>()
  for (const plugin of plugins) {
    if (plugin.origin.kind !== 'linked' || plugin.origin.repo === '') continue
    keys.add(`${plugin.origin.repo}@${plugin.origin.sha}`)
  }
  return keys.size
}

async function main(): Promise<void> {
  await officialMarketplace()
  cachedScansPredatingTheseFields()
  cachedScansPredatingPluginArtwork()
  await pluginArtworkFields()
  await renamesOfNamesStillListed()
  await readBudget()
  await linkedPluginsFollowed()
  await linkedPluginsPartial()
  await anInfiniteBudgetReadsEveryRepository()
  shortfallReadsTheTransport()
  await aLostFileIsNotAnAbsentFile()
  await linkedPluginRead()
  await skillsOnlyRepositories()
  await rootServers()
  parsers()
  console.log('skills plugin scan tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
