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
  pluginAliases,
  scanPluginRenames,
  scanPlugins,
  scanShape,
  type ScanResult,
} from '../../shared/skills'
import { scanSkillTree, type SkillTreeEntry } from './scan'
import {
  CLAUDE_MARKETPLACE_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  githubRepoFromUrl,
  MAX_SCANNED_PLUGINS,
  parseHooks,
  parseLspServers,
  parseMarketplaceManifest,
  parseMcpRegistryManifest,
  parseMcpServers,
  readPluginComponents,
  scanPluginTree,
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
  const afterLinked = await scanPluginTree({
    entries,
    skills: [],
    marketplaceManifest: JSON.stringify({ name: 'm', plugins: linkedEntries }),
    readFile: async () => null,
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
  const capped = await scanPluginTree({ entries: many, skills: [], marketplaceManifest: null, readFile: async () => null })
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

async function main(): Promise<void> {
  await officialMarketplace()
  await readBudget()
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
